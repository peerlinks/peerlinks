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
4. Confidentiality of messages. Only past and current channel participants
   can read the messages. NOTE: There is no end-to-end encryption involved
   at least in not in this version of the protocol
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
  uint32 version = 1;
  string peer_id = 2;
}
```

NOTE: `peer_id.length` MUST be checked to be equal to 32 bytes.

The `hello.version` specifies the protocol version and MUST be checked by the
recipient. In case of the mismatch and/or other errors `Error` SHOULD be sent:
```proto
message Error {
  string reason = 1;
}
```
and connection MUST be closed.

NOTE: `reason.length` MUST be checked to be less than 1024 utf-8 characters.

Further communication between peers happens using:
```proto
message Packet {
  oneof content {
    Error error = 1;
    EncryptedInvite invite = 2;

    // Synchronization
    Query query = 3;
    QueryResponse query_response = 4;
    Bulk bulk = 5;
    BulkResponse bulk_response = 6;

    // Request synchronization on new messages
    Notification notification = 7;
  }
}
```
Particular packet sub-types are described below.

_(TODO(indutny): find a mechanism to deter peers from spamming each other.
Rate limit does not work, because the peer cannot be identified consistently
in `MultipeerConnectivity`)_

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

  message Body {
    oneof body {
      Root root = 1;
      string json = 2;
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
      int64 height = 5;
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
  int64 height = 3;

  // Encryption nonce for Sodium
  bytes nonce = 4;

  // NOTE: encryption key = HASH(channel_pub_key, 'vowlink-symmetric')
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

Maximum text length in `json` is:
* Unlimited for `chain.length == 0`
* `262144` for `chain.length == 1`
* `8192` for `chain.length == 2`
* `256` for `chain.length == 3`
in UTF-8 characters and MUST be enforced.

`message.content.body` MUST be `json` for non-root messages.

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
1. Take all current DAG leaves
2. Find the maximum of their timestamps
3. Remove those that differ from the maximum timestamp by more than **30 days**.
These leaves SHOULD be used as parents for the new message. Peers naturally
merge different branches into a single new leaf.

### Link

The `chain` is a collection of signed links:
```proto
message Link {
  message TBS {
    bytes trustee_pub_key = 1;
    string trustee_display_name = 2;
    double expiration = 3;

    // NOTE: This MUST be filled either by sender/recipient before
    // generating/verifying the signature below.
    bytes channel_id = 4;
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

`trustee_display_name` is assigned by the issuer of the link. Maximum length of
this string is 128 UTF-8 characters and MUST be enforced. Note that each
participant of the channel gets unique "display path" (array of display names)
starting from the root.

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
  bytes peer_id = 1;
  bytes trustee_pub_key = 2;
  bytes box_pub_key = 3;
}
```
where `trustee_pub_key` is the invitee's public key. `box_pub_key` is from
`sodium.box.keyPair()`.

NOTE: requesting invite reveals public key and an associated channel.

Upon receiving `InviteRequest` the peer having write access to the channel MUST
consider the invitation carefully and ONLY IN CASE of user confirmation issue
an `EncryptedInvite`:
```proto
message EncryptedInvite {
  // NOTE: `request_id = req.box_pub_key`
  bytes request_id = 1;

  bytes box = 2;
}
```

NOTE: `encrypted_invite.request_id` MUST be equal to
`invite_request.box_pub_key`.

NOTE: `peer_id.length` MUST be checked to be equal to 32 bytes.
`trustee_pub_key` and `box_pub_key` lengths MUST be checked.

The `encrypted_invite.box` can be decrypted with `box_priv_key` that the issuer
of `InviteRequest` MUST know from the moment the generated `InviteRequest`. When
decrypted `encrypted_invite.box` becomes:
```proto
message Invite {
  bytes channel_pub_key = 1;
  string channel_name = 2;
  ChannelMessage channel_root = 3;

  repeated Link chain = 4;
}
```

NOTE: `encryptedInvite.box = nonce + ciphertext + mac`. See
`sodium.crypto_box_seal_open`.

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
  oneof cursor {
    int64 height = 2;
    bytes hash = 3;
  }
  bool is_backward = 4;
  uint32 limit = 5;
}
```
The `query.cursor` MUST be either of `height` or `hash`.

The remote peer responds with:
```proto
message QueryResponse {
  message Abbreviated {
    repeated bytes parents = 1;
    bytes hash = 2;
  }

  bytes channel_id = 1;
  repeated Abbreviated abbreviated_messages = 2;
  bytes forward_hash = 3;
  bytes backward_hash = 4;
}
```

The synchronization process is following:
1. Send `Query` with `cursor.height` set to local `min_leaf_height` (see below)
2. Recipient of `Query` with `cursor.height` computes the starting `height` as
   `min(min_leaf_height, cursor.height)`
3. Recipient replies with a slice of the list of abbreviated messages (see CRDT
   Order below) starting from the first message of `message.height == height`
   and either up to the latest message or up to `query.limit` messages total
4. The recipient walks over received messages sequentially, `Bulk`-requesting
   the messages with known parents and messages with parents in the
   `QueryResponse`
5. The recipient SHOULD keep the list of unknown parents seen so far, and in
   case if the list does not overflow should proceed to loop below:
  1. If the count of unknown parents is non-zero - issue a query with
     `cursor.hash = response.backward_hash` and `is_backward = true`
  2. Once there are no more unknown parents - the recipient repeatedly issues a
     query with `is_backward = false` and `cursor.hash = reponse.forward_hash`
5. The synchronization is complete when the response the response with
   `forward_hash == nil` is fully processed and has no missing parents.

Malicious nodes or DAGs with divergent branches may overflow the list of
unknown parents. In this case, `cursor.hash` has to be set to `root.hash`, and
`is_backward` should be set to `false`. In other words, the sync has to start
from the very first message. This is called "Full Sync".

### Bulk fetch

During synchronization process above the recipient MUST request the messages
that are not present in their dataset. This can be done with `Bulk` packet:
```proto
message Bulk {
  bytes channel_id = 1;
  repeated bytes hashes = 2;
}
```

Remote side SHOULD reply with as many messages as possible. The messages should
be in the side order as in `bulk.hashes`, except for allowed omissions for
those hashes that were not found in the datastore or the trailing hashes that
are omitted due to some constraints. In the latter case `forward_index` MUST be
set to the number of processes messages:
```proto
message BulkResponse {
  bytes channel_id = 1;
  repeated ChannelMessage messages = 2;
  uint32 forward_index = 3;
}
```

The originator of `Bulk` SHOULD resume the fetch if `response.forward_index` is
not equal to the number of `bulk.hashes` they sent.

### CRDT Order

The messages in channel MUST be sorted by increasing `height` and then by
increasing `hash`. Thus the list of messages per-channel becomes a [CRDT][]
list, and two fully synchronized peers MUST agree completely on the order of
the messages.

_(TODO(indutny): does 30 day delta mechanism help here?)_

### New messages

On either received or posted message the peer MUST send:
```proto
message Notification {
  bytes channel_id = 1;
}
```
to notify ALL connected peers that new data is available for the channel. The
subscribed peers SHOULD attempt to do a synchronization.

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
