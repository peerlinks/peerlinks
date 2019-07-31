# Protocol

## Overview

```
PeerToPeer
DHT public pool (encrypted using public-key) + subscribed feeds
Link protocol | Channel protocol
```

Here and below `HASH(message, key)` is keyed `BLAKE2b`. Whenever `key` in `HASH`
is omitted, the `HASH` is assumed to be non-keyed.

The public/private keys are ed25519 keys. The AES key size is 192 bits.

Protocol buffers are used for all messages below.

_(TODO: use `channel_pub_key ++ current_day_ts` for the channel_id?)_

Channel identifier is a
`channel_id = HASH(channel_pub_key, 'vowlink-channel-id')[:32]`,
inspired by [DAT][] all channel messages are encrypted with AES using
`channel_key = HASH(channel_pub_key, 'vowlink-channel-key')[:24]`. The encrypted
message is authenticated using
`channel_mac_key = HASH(channel_pub_key, 'vowlink-channel-mac')`:

```
EncryptedMessage {
  TBSMessage {
    [ channel_id ] [ channel_key_iv ]
    [ AES(channel_key, channel_key_iv, message) ]
  }
  [ HASH(TBSMessage, channel_mac_key) ]
}
```

In this way data in the public pool cannot be censored by the peers
participating in the P2P.

## P2P

Each peer assingns themselves a random
binary `peer_id = RANDOM[:32]`. `peer_id` is persisted between restarts of the
application. The first message that they send is

```
Hello {
  [ version (big endian int32) ]
  [ peer_id ]
  [ maximum number of messages per hour ]
}
```

The peers that violate the rate limit SHOULD have their peer id banned for
at least 1 hour. The connection to them MUST be closed.

Peer MUST drop connection if the protocol version does not match.

## DHT

DHT uses a form of rendezvous hashing.
`content_hash = HASH(peer_id ++ EncryptedMessage, 'vowlink-dht')`
is computed for each peer and message. `content_hash` is interpreted as a
network order integer. `DHT_SCALE = 7` peers with lowest `content_hash` receive
the message. Even if the message is transferred to other peer, the copy of it
kept in the public pool or subscribed feeds according to their respective
eviction policies defined below.

The peer SHOULD attempt to store in DHT their own messages and SHOULD redirect
the remote stores according the rendezvous hashing algorithm above.

## Storage and eviction policies

The amount of storage SHOULD be configurable in the application (with potential
notifications for increasing the limit when needed). The split between public
pool and subscribed feeds MAY be configurable.

Public pool sorts the messages in the order they were received. Duplicates are
ignored and do not change the order (TODO: reconsider this?). When the available
storage is exhausted messages are evicted one-by-one until the required amount
of storage is regained. Public pool SHOULD not evict messages unless needed.
Public pool SHOULD persist messages between application restarts.

Subscribed channels have to evict some messages on storage exhaustion as well.
Each message is assigned a rank (defined below). The eviction removes only the
messages that have the lowest rank and the oldest among the ones that stored
until enough space is regained. Subscribed channels SHOULD persist messages
between application restarts. The messages with the highest rank (channel
messages) MUST not be removed under any circumstances as they provide
mandatory channel information.

## Trust

Channel and users can issue a trust token (Link) valid for 99 days:
```
Link {
  TBSLink {
    [ trustee_pub_key ]
    [ expiration_date (big endian float64 seconds since Jan 1st 1970 00:00:00 UTC) ]
    [ optional trustee_display_name (utf8 string) ]
  }

  [ ed25519_sign(HASH(TBSLink), issuer_priv_key) ]
}
```

Peer MUST validate that `trustee_display_name` is valid UTF-8 string (no hanging
UTF pairs). The maximum length of `trustee_display_name` is 64 bytes. The
issuer SHOULD consider issuing two links, one with the display name present and
another without it. See chain section below.

Peer MUST NOT check that `expiration_date` is at most 99 days. However, peer
MUST issue the link that is valid only for 99 days.

Peer requests `Link` to be issued by sending:
```
LinkRequest {
  [ trustee_pub_key ]
  [ optional desired_display_name (utf8 string) ]
}
```

Recipient of `LinkRequest` MUST validate that `desired_display_name` is valid
UTF-8 string. The maximum length of `desired_display_name` is 64 bytes.

Trustee MAY validate that the `Link` contains the desired display name of
their choice. However, some channels might prefer to issue the display names
in top-bottom manner.

## Trust in Detail

Reading the channel messages is possible using only a public key of the channel.
Posting the messages to the channel, however, requires establishing a chain of
`Link` starting with a `channel_pub_key`.
The validity time of such chain is the minimum of `expiration_date` in all
links.

The maximum allowed length of any chain is `5`. Chain length is equal to the
RANK of the message. Channel messages have the HIGHEST rank `0`, `5` - is the
LOWEST possible rank. All links in the chain but the last one SHOULD not have
`trustee_display_name` set to save the storage.

Various channel limits SHOULD be applied depending on the RANK of the message.
Highest-rank and rank-1 messages should not be limited as they belong to the
channel and its operators.

Since number of links that could be sent is limited to `5`. The peer is
encouraged by the limits above and their desire to post new messages to seek
the ways to shorten their chain. This could happen in two ways:

1. Either the peer finds a higher-ranked peer that is willing to issue a
   a better link for them
2. One of the issuers in the peer's link chain receives a better link

## Messages

```
Message {
  [ issue_date (big endian float64 seconds since Jan 1st 1970 00:00:00 UTC) ]
}
```

## Synchronization

Ideas: ranked vector clocks, higher-ranked peers issuing checkpoints. Similar to
bitcoin pool.

## Relays

A non-P2P webserver MAY be used as an online relay for the messages. Although
the servers themselves MAY be untrusted, the protocol ensures that the
communication is safe.

# UX

1. User has to recite channel "vows" before receiving the trust link.

[DAT]: https://docs.datproject.org/
