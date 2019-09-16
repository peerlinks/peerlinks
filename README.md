# PeerLinks
[![Build Status](https://travis-ci.org/peerlinks/peerlinks.svg?branch=master)](http://travis-ci.org/peerlinks/peerlinks)
[![IRC Channel](https://img.shields.io/badge/IRC-%23peerlinks-1e72ff.svg?style=flat)][comm-irc]
![License](https://img.shields.io/npm/l/@peerlinks/protocol)

![banner](https://raw.githubusercontent.com/peerlinks/peerlinks-desktop/master/Artwork/banner-slim-1280x320.png)

PeerLinks is a protocol for building "Distributed Secure IRC" (or distributed
Slack if you wish). The core principles are:

* No server required
* Untrusted parties help distribute messages
* Invites reveal messages to new participants
* The "invite chain" involves 3 people or less
* Write access expires after 99 days.

**NOTE: The protocol is still under development. Breaking changes will be
avoided whenever possible.**

## Trying it out

The [Desktop Client][desktop] is a great way to start using the protocol with
your peers. Once installed the identities and channels can be created.
Once requested an invite to other's channel, or approved an invite for someone
else the familiar UI (:wink:) will help to make the conversation over a P2P
network.

![screenshot](https://raw.githubusercontent.com/peerlinks/peerlinks-desktop/master/Artwork/desktop-demo.gif)

## Protocol

The [Protocol][Protocol] and all repositories in [GitHub organization][org] are
Open Source (MIT Licensed). Aside from other benefits this means that a custom
client can connect to the network. PeerLinks is not a [walled garden][Slack].

## Usage

Initialization (requires [`sodium-universal`][sodium] or any other library with
compatible API):
```js
import * as sodium from 'sodium-universal';
import PeerLinks, { Message, StreamSocket } from '@peerlinks/protocol';
import SqliteStorage from '@peerlinks/sqlite-storage';

// Initialize persistence layer
const storage = new SqliteStorage({
  file: 'db.sqlite',
  passphrase,
});
await storage.open();

// Initialize protocol layer
const peerLinks = new PeerLinks({
  sodium,
  storage,
  passphrase: 'secret',
});
const isRightPassphrase = await peerLinks.load();
if (!isRightPassPhrase) {
  throw new Error('Invalid passphrase');
}

// Create identity (and associated channel)
// NOTE: multiple identities/channels are supported
const identity = await peerLinks.createIdentity('identity-name');
const channel = peerLinks.getChannel('identity-name');
```

See [@peerlinks/hyperswarm][swarm] for details on connecting to remote peers and
requesting/issuing invites.

Process incoming messages (and similarly outgoing with `waitForOutgoingMessage`:
```js
function loop() {
  const wait = channel.waitForIncomingMessage();
  wait.then((message) => {
    // Display message
    loop();
  });

  // Call `wait.cancel()` if needed
}
loop();
```
See [promise-waitlist][] for waiting APIs here and in later code samples.
`waitForUpdate` could be used to refresh the channel contents.


Post a new message:
```js
const author = identity;
await channel.post(Message.json({ /* any json data here */ }), author);
```

Display channel messages:
```js
// Get the latest 100 messages
const messages = await channel.getReverseMessagesAtOffset(
  0, // end of the message list
  100 // limit
);

for (const message of messages.slice().reverse()) {
  const displayPath = message.getAuthor().displayPath;

  const text = message.isRoot ? '<root>' : message.json.text;

  console.log(`${displayPath.join('>')}: ${text}`);
}
```

Create read-only channel using its public key obtained elsewhere:
```js
cosnt feed = await peerLinks.feedFromPublicKey(
  publicKey,
  { name: 'channel-name' });
```

## Help requested

The protocol draft and the implementations are in the very early stages. Any
feedback or ideas on boths are very appreciated.

Not exhaustive list of possible issues:

* Unclear wording in the protocol description
* Cryptography problems
* Bugs in implementation
* API improvements
* Documentation!

## Community

* [#peerlinks][comm-irc] IRC Channel on FreeNode.

## LICENSE

This software is licensed under the MIT License.

Copyright Fedor Indutny, 2019.

Permission is hereby granted, free of charge, to any person obtaining a
copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the
following conditions:

The above copyright notice and this permission notice shall be included
in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
USE OR OTHER DEALINGS IN THE SOFTWARE.

[Protocol]: protocol.md
[promise-waitlist]: https://github.com/indutny/promise-waitlist
[swarm]: https://github.com/peerlinks/peerlinks-swarm
[desktop]: https://github.com/peerlinks/peerlinks-desktop/releases/latest
[comm-irc]: https://www.irccloud.com/invite?channel=%23peerlinks&hostname=irc.freenode.net&port=6697&ssl=1
[sodium]: https://github.com/sodium-friends/sodium-universal
[org]: https://github.com/peerlinks/
[Slack]: https://slack.com/
