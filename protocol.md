# Protocol

**DRAFT**

## Goals

The goals of this protocol are:
1. Provide semi-trusted parties with the means of peer-to-peer communication in
   group chats (channels)
2. Using untrusted parties that do not participate in the channels as the means
   of transport of channel messages to interested peers
3. Efficient synchronization of channel messages between semi-trusted and
   untrusted peers
4. Confidentiality of messages. Only semi-trusted peers can read channel
   messages
5. Eventual consistency. Messages must be viewable offline. New messages can be
   posted offline and distributed once remote peers are available.

## Notes

Here and below [Sodium][] is used for all cryptography operations.

[Protocol Buffers][] are used for encoding of all messages.

Channel identifier is generated with:
```
channel_id = HASH(channel_pub_key, 'vowlink-channel-id')[:32]
```
inspired by [DAT][] all channel messages are encrypted with `sodium.secretBox`
using:
```
symmetric_key = HASH(channel_pub_key, 'vowlink-symmetric')[:sodium.secretBox.keySize]
```

The protocol below is transport-agnostic in a sense that it could be run using
any available transport: [MultipeerConnectivity][], https, ...

Everywhere below "TBS" stands for To Be Signed and indicates the data that is
signed by the `signature`.

## Initialization sequence

The first message over any wire protocol MUST be:
```proto
message Hello {
  int32 version = 1;
}
```

The `hello.version` specifies the protocol version and MUST be checked by the
recipient. In case of the mismatch and/or other errors `Error` SHOULD be sent:
```proto
message Error {
  string reason = 1;
}
```
and connection MUST be closed.

Further communication between peers happens using:
```proto
message Packet {
  oneof content {
    EncryptedInvite invite = 1;
    ChannelMessage message = 2;
    Error error = 3;
    Subscribe subscribe = 4;

    Query query = 5;
    QueryResponse query_response = 6;
  }
}
```
Particular packet sub-types are described below.

_(TODO(indutny): find a mechanism to deter peers from spamming each other.
Rate limit does not work, because the peer cannot be identified consistently
in `MultipeerConnectivity`)_

Each peer has a list of `Channel`s that they "follow". In order to receive
channel updates they sent several `Subscribe` packets after `Hello`:
```proto
message Subscribe {
  bytes channel_id = 1;
}
```
The recipient MUST validate the length of `channel_id`.

## Channels, messages, and identities

At this point the peers SHOULD issue synchronization queries, but this section
is not possible to discuss without discussing what channels and messages are.

Each peer SHOULD have one or more identities. The identity is:
1. Asymmetric key pair (`sodium.sign.keyPair`)
2. A set of "chains" for each channel the identity is allowed to post to.

### Message

Each identity comes with their own channel (just as twitter users have their
own feed). The channel MUST have a root message and MAY have more messages of
following format:
```proto
message ChannelMessage {
  // First message on any channel
  message Root {
  }

  message Text {
    string text = 1;
  }

  message Body {
    oneof body {
      Root root = 1;
      Text text = 2;
    }
  }

  message Content {
    message TBS {
      repeated Link chain = 1;
      double timestamp = 2;
      Body body = 3;

      // NOTE: Despite these fields being outside of content they have to be
      // included here to prevent replay attacks
      repeated bytes parents = 4;
      uint64 height = 5;
    }

    // Link chain that leads from the channel's public key to the signer of
    // this message
    repeated Link chain = 1;

    // Floating point unix time
    double timestamp = 2;

    // body of the message
    Body body = 3;

    bytes signature = 4;
  }

  bytes channel_id = 1;

  // NOTE: can be empty only in the root message
  repeated bytes parents = 2;

  // height = max(p.height for p in parents)
  uint64 height = 3;

  // Encryption nonce for Sodium
  bytes nonce = 4;

  bytes encrypted_content = 5;
}
```

Despite having many fields the aim of `ChannelMessage` is to form a Direct
Acyclic Graph (DAG) similar to the commit graph in [git][]. In other words,
each message except for the root MUST have one or more parents.
`message.parents` contains the hashes of these parents, and the hash of the
`message` might be used as a parent for some future message. Thus messages form
a directed graph with no cycles (merges are possible, but just as in [git][]
they are not cycles because of edge directions).

The hash of the message is computed as:
```
hash = HASH(Content)[:32]
```

Maximum text length in `Text` is `256` UTF-8 characters and MUST be enforced.

`message.height` is a number of edges between the `message` and the
`channel.root`. `channel.root` naturally MUST have `height = 0`, and in general
any message MUST have:
```
height = max(p.height for p in parents) + 1
````
`height` is an essential property for synchronization (more on it later).

`content.timestamp` MUST be a valid Unix time since Jan 1st 1970 00:00:00 UTC,
and MUST be greater or equal to the maximum timestamp of the message parents.
`content.timestamp` MUST NOT be too far in the future. Particular implementation
SHOULD decide on the value of this leeway (5-10 seconds is recommended).

The validity of `content.timestamp` and the expiration of links MUST be enforced
through the following mechanism. Suppose that for a received `message`:
```
min_timestamp = min(p.content.timestamp for p in message.parents)
max_timestamp = max(p.content.timestamp for p in message.parents)
```
The `message` MUST NOT be accepted and should be treated as INVALID (peer SHOULD
issue an `Error` protocol packet and MUST close the connection to such peer) if:
```
delta_time = max_timestamp - min_timestamp
```
is greater than *30 days*. This mechanism ensures that the peers with expired
links can at worst create messages in the past, and that after 30 days those
messages will no longer need to be synchronized or persisted.

NOTE: It is still possible for peers with valid chain to re-introduce those
messages from the past into the current branch of DAG if they are out-of-sync
with other peers. However, the mechanism above makes it unlikely (especially
with introductions of https relays.)

The subscribers of the channel MUST verify the messages against full DAG:

* `height` MUST be checked
* `parents` MUST lead to the root, and MUST NOT be empty
* `content.box` MUST be signed
* `chain` MUST lead to the channel's public key and MUST not be longer than 5
  links
* `signature` MUST come from the last link's public key
* `timestamp` MUST be greater or equal to the MAXIMUM of `timestamps` of
  parent messages, and SHOULD not be in the future. It is understood that the
  clocks are not ideal, so the "SHOULD" in the previous sentence means that
  small leeway has to be allowed. Several seconds of leniency should be enough
* `timestamp` MUST be less than the minimum of `expiration` of links in the
  `chain`.

### Merges

Whenever new message is posted by a participant it SHOULD:
1. Take all current DAG leafs
2. Find the maximum of their timestamps
3. Remove those that differ from the maximum timestamp by more than **30 days**.
These leafs SHOULD be used as parents for the new message. Peers naturally merge
different branches into a single new leaf.

### Link

The `chain` is a collection of signed links:
```proto
message Link {
  message TBS {
    bytes trustee_pub_key = 1;
    double expiration = 2;

    // NOTE: This MUST be filled either by sender/recipient before
    // generating/verifying the signature below.
    bytes channel_id = 3;
  }

  TBS tbs = 1;
  bytes signature = 2;
}
```
that establish trust in a manner
similar to [Public Key Infrastructure][] (PKI). Each successive link in a chain
is signed by the private key of the previous link. The first link is signed by
the root. The maximum length of the chain is `3`. Peer MUST validate the length
of the chain against the limit, and MUST NOT accept messages with longer chains.
(This should encourage peers to form tighter groups, and have more control
over participants. The number `3` MAY be revised in the future version of the
protocol.)

The `link.expiration` is a Unix-time from Jan 1st 1970 00:00:00 UTC. The
expiration date/time of the whole `chain` is the minimum of expirations of
all links. This mechanism ensures granularity of control over peers' ability
to write new messages. The expiration of the chain MUST be checked against the
`content.timestamp` (see constraints on `content.timestamp` above.)

The `message.signature` MUST be generated using the private key that corresponds
to the last public key in the chain, or the channel's private key if the chain
is empty.

`nonce` MUST be a random value used by [Sodium][]'s `secretBox` to encrypt the
contents of the message with `symmetric_key`. Note: because `symmetric_key` is
known only to those who know the `channel_pub_key`, the messages can be stored
on untrusted peers without any loss of confidentiality.

### Invite

It is easy to see that the write access to the channel MUST be checked by
validating the `chain`. Peers that do not have valid chain can read the channel,
but cannot write to it. The members of channel with write access can invite
other peers to participate in this channel by first requesting from them in a
form of scanned QR code (or by other means):
```proto
message InviteRequest {
  string peer_id = 1;
  bytes trustee_pub_key = 2;
  bytes box_pub_key = 3;
}
```
where `trustee_pub_key` is the invitee's public key. `box_pub_key` is from
`sodium.box.keyPair()`.

Upon receiving `InviteRequest` the peer having write access to the channel MUST
consider the invitation carefully and ONLY IN CASE of user confirmation issue
an `EncryptedInvite`:
```proto
message EncryptedInvite {
  bytes box = 1;
}
```

The `encrypted_invite.box` can be decrypted `box_priv_key` that the issuer of
`InviteRequest` MUST know from the moment the generated `InviteRequest`. When
decrypted `encrypted_invite.box` becomes:
```proto
message Invite {
  bytes channel_pub_key = 1;
  string channel_name = 2;
  ChannelMessage channel_root = 3;

  repeated Link chain = 4;
}
```

The `channel_name` is a suggested name for the channel and MUST have no more
than `128` UTF-8 characters. `channel_root` MUST be decryptable using
`symmetric_key`, MUST have empty `content.chain`, and MUST be signed by
`channel_priv_key`.

The `invite.links` MUST be a chain from `channel_priv_key` to the
`request.trustee_key`.

### Synchronization

This DAG would make little sense without synchronization.

Unencrypted `Query` is sent in order to request the latest messages from the
channel:
```proto
message Query {
  bytes channel_id = 1;
  uint64 min_height = 2;
  bytes cursor = 3;
  uint64 limit = 4;
}
```

It is trivial to filter the messages with `height` greater or equal to
`sync.min_height`. Peers SHOULD send all messages with the `message.height`
greater or equal to `sync.min_height`. If `cursor` is present, the query MUST
continue from it (the definition of cursor is dependent upon implementation
of the remote peer, and MAY or MAY NOT be a message hash):
```proto
message QueryResponse {
  bytes channel_id = 1;
  repeated ChannelMessage messages = 2;
  bytes forward_cursor = 3;
  bytes backward_cursor = 4;
  uint64 min_leaf_height = 5;
}
```

It might be the case that either the recipient is an untrusted peer and has only
disconnected portions of DAG, or that the DAG of sender and recipient has
diverged at `message.height` less than `sync.height`. The sender SHOULD
repeatedly re-issue `Query` cursor set either to `forward_cursor` or
`backward_cursor` until all messages are received.

`min_leaf_height` is a suggestion for a better sync point, in case if there are
different branches. In the example below top branch represents local messages,
bottom branch represents remote messages. Requesting `min_height = 2` from
remote MUST result in query response with `min_leaf_height = 1`:

```
h=0 | h=1       | h=2
* - | --- * --- | --- *
 \  |           |
  \ |           |
   \|           |
    |           |
    | \         |
    |  *        |
```

IMPORTANT: leafs that are further than 30 day from the latest (by timestamp)
leaf MUST be ignored by `min_leaf_height` as they are ignored for merges.

The messages in channel MUST be sorted by increasing `height` and then by
increasing `hash`. Thus the list of messages per-channel becomes a [CRDT][]
list, and two fully synchronized peers MUST agree completely on the order of
the messages.

_(TODO(indutny): does 30 day delta mechanism help here?)_

## DHT

WIP

DHT uses a form of rendezvous hashing:
```
content_hash = HASH(peer_id ++ channel_id, 'vowlink-dht')
```
is computed for each peer and message. `content_hash` is interpreted as a
network order integer. `DHT_SCALE = 7` peers with lowest `content_hash` receive
the message. Even if the message is transferred to other peer, the copy of it
kept in the public pool or subscribed feeds according to their respective
eviction policies defined below.

The peer SHOULD attempt to store in DHT their own messages and SHOULD redirect
the remote stores according the rendezvous hashing algorithm above.

## Storage and eviction policies

WIP

The amount of storage SHOULD be configurable in the application (with potential
notifications for increasing the limit when needed). The split between public
pool and subscribed feeds MAY be configurable.

Public pool sorts the messages in the order they were received. Duplicates are
ignored and do not change the order (TODO: reconsider this?). When the available
storage is exhausted messages are evicted one-by-one until the required amount
of storage is regained. Public pool SHOULD not evict messages unless needed.
Public pool SHOULD persist messages between application restarts.

_(TODO(indutny): does 30 day delta mechanism help here?)_
There is no mechanism for evicting the messages from channels the user is
subscribed too. However, in the future versions the channel operator MAY be able
to issue a new channel root from time to time so that past DAGs may be evicted.

## Relays

HTTPS webserver MAY be used as a remote peer to facilitate synchronization
between peers that are not in vicinity of each other physically.

# UX

Ideas:
1. User has to recite channel "vows" before receiving the trust link.

[DAT]: https://docs.datproject.org/
[Sodium]: https://download.libsodium.org/doc/
[Protocol Buffers]: https://developers.google.com/protocol-buffers/
[MultipeerConnectivity]: https://developer.apple.com/documentation/multipeerconnectivity
[git]: https://git-scm.com/
[Public Key Infrastructure]: https://en.wikipedia.org/wiki/Public_key_infrastructure
[CRDT]: https://en.wikipedia.org/wiki/Conflict-free_replicated_data_type
