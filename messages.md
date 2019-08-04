# Messages

The messages sent on a channel should be synchronizable between:

1. Mostly untrusted channel participants
2. Completely untrusted network nodes (and relays)

The goals of the protocol defined below are:

1. Efficient (eventual) synchronization
2. Confidentiality. Only subscribers of the channel has to be able to see the
   messages
3. Eventual consistency. Participants should be able to view the messages
   offline and post new messages even if their state is out-of-sync

## Protocol

### Messages

```proto
message ChannelMessage {
  message Content {
    message TBS {
      // Link chain that leads from the channel's public key to the signer of
      // this message
      repeated Link chain = 1;

      // Floating point unix time
      double timestamp = 2;

      // JSON content of the message
      string json = 3;
    }

    TBS tbs = 1;
    bytes signature = 2;
  }

  bytes channel_id = 1;
  repeated bytes parents = 2;
  uint64 height = 4;

  bytes encrypted_content = 5;
}
```

Symmetric encryption key is defined as
`HASH(channelPubKey, 'vowlink-symmetric')`. `channel_id` is
public, but `channel_pub_key` is only known to subscribers. This way the
confidentiality is achieved, and yet untrusted peer can help synchronize the
messages.

Only the root message signed by the channel's owner is allowed to have empty
`parents` array. Potentially, future versions of protocol could allow multiple
roots for "checkpointing" purposes. All other messages MUST have at least one
parent, and in all implementations SHOULD include ALL LOCAL leaf messages.
Thus a new message becomes a leaf, at least locally. The `hash` of the message
to be used in `parents` is a keyed hash of serialized `ChannelMessage`:
```
HASH(ChannelMessage, 'vowlink-message')
```

TODO(indutny): Invitation to the channel MUST have signed

`height` of the root is zero. For other messages it MUST be checked by recipient
to be:
```javascript
height = Math.max(...parents.map((p) => p.height)) + 1
```

### Validation

Nodes outside of semi-trusted channel subscribers may have at best only a part
of this DAG. Therefore they MUST NOT do any verification except for the hashes
of known messages and their parents. Non-subscribers generally will have
one or more disconnected DAGs for the same channel.

The subscribers of the channel MUST verify the messages against full DAG:

* `height` MUST be checked
* `parents` MUST lead to the root
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

### Synchronization

This DAG would make little sense without synchronization.

Unencrypted `Sync` is sent in order to request the latest messages from the
channel:
```proto
message Sync {
  bytes channel_id = 1;
  uint64 min_height = 2;

  // Optional, see re-issue below
  uint64 max_height = 3;
}
```

It is trivial to filter the messages with `height` greater than
`sync.min_height`. Peers SHOULD send all messages with the `message.height`
greater than `sync.min_height` and less or equal to `sync.max_height` (if
it is present):
```proto
message SyncResponse {
  bytes channel_id = 1;
  repeated ChannelMessage messages = 2;
}
```

It might be the case that either the recipient is an untrusted peer and has only
disconnected portions of DAG, or that the DAG of sender and recipient has
diverged at `message.height` less or equal to `sync.height`. The sender SHOULD
repeatedly re-issue `Sync` with lowered `min_height` value by increments of 16
and `max_height` equal to the last sent `sync.min_height` until the first common
`message` is found.

At any point ynchronization MUST be interrupted if the received
`sync_response.messages` is empty.
