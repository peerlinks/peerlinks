import { Buffer } from 'buffer';
import * as sodium from 'sodium-universal';
import * as bs58 from 'bs58';

import Protocol, { Message }from '@vowlink/protocol';
import Swarm from '@vowlink/swarm';

const DISPLAY_COUNT = 30;

const INVITE_TIMEOUT = 15 * 60 * 1000; // 15 minutes

export default class Chat {
  constructor(repl, storage) {
    this.repl = repl;
    this.repl.setPrompt('> ');
    this.repl.displayPrompt(true);

    this.storage = storage;
    this.swarm = null;

    this.protocol = new Protocol({ storage, passphrase: 'test', sodium });
    this.identity = null;
    this.channel = null;
    this.channelWait = null;
  }

  async load() {
    await this.protocol.load();

    this.swarm = new Swarm(this.protocol);
  }

  async iam(name) {
    if (!name) {
      throw new Error('Usage: iam([ name ])');
    }

    const existing = this.protocol.getIdentity(name);
    let channel;
    if (existing) {
      this.identity = existing;
      channel = this.protocol.getChannel(name);
    } else {
      [ this.identity, channel ] =
        await this.protocol.createIdentityPair(name);
    }
    this.setChannel(channel.name);

    return existing ? `Using identity: "${name}"` :
      `Created identity: "${name}"`;
  }

  async requestInvite() {
    if (!this.identity) {
      throw new Error('`iam()` must be called first');
    }

    const { requestId, request, decrypt } = this.identity.requestInvite(
      this.protocol.id);

    const request58 = JSON.stringify(bs58.encode(request));
    const trusteeName = JSON.stringify(this.identity.name);

    console.log('Ask your peer to run:');
    console.log(`issueInvite(${trusteeName},${request58})`);
    console.log('...waiting');

    const encryptedInvite = await this.swarm.waitForInvite(
      requestId, INVITE_TIMEOUT).promise;
    const invite = decrypt(encryptedInvite);

    const channel = await this.protocol.channelFromInvite(
      invite, this.identity);

    // Join channel's swarm to start synchronization
    await this.setChannel(channel.name);

    return `Joined channel: "${this.channel.name}"`;
  }

  async issueInvite(inviteeName, request) {
    if (!this.identity) {
      throw new Error('`iam()` must be called first');
    }
    if (!request || !inviteeName) {
      throw new Error(
        'Usage: issueInvite(inviteeName, < base58 request string >)');
    }

    request = bs58.decode(request);

    const { encryptedInvite, peerId } = this.identity.issueInvite(
      this.channel, request, inviteeName);

    await this.swarm.sendInvite({
      peerId,
      encryptedInvite,
    }, INVITE_TIMEOUT).promise;

    return '(issued invite)';
  }

  async post(text) {
    if (!this.identity) {
      throw new Error('`iam()` must be called first');
    }

    const body = Message.json({ text });
    const message = await this.channel.post(body, this.identity);

    await this.displayChannel();

    return '(successfully posted message)';
  }

  channels() {
    console.log(this.protocol.getChannelNames().map((name) => {
      return `setChannel(${JSON.stringify(name)})`;
    }).join('\n'));
    return '(done)';
  }

  identities() {
    console.log(this.protocol.getIdentityNames().map((name) => {
      return `iam(${JSON.stringify(name)})`;
    }).join('\n'));
    return '(done)';
  }

  async setChannel(name) {
    if (this.channelWait) {
      this.channelWait.cancel();
      this.channelWait = null;
    }

    const channel = this.protocol.getChannel(name);
    if (!channel) {
      throw new Error(`Unknown channel: "${name}". ` +
        `Use \`requestInvite()\` to join`);
    }

    const loop = () => {
      this.channelWait = channel.waitForIncomingMessage();

      this.channelWait.promise.then(() => {
        this.channelWait = null;

        // Bell sound
        process.stdout.write('\u0007');

        this.displayChannel().catch(() => {
          // ignore
        });
        loop();
      }).catch(() => {
        // ignore
      });
    };

    this.channel = channel;
    this.swarm.joinChannel(channel);

    loop();

    await this.displayChannel();

    return '(joined channel)';
  }

  //
  // Utils
  //

  async displayChannel() {
    const messages = await this.channel.getReverseMessagesAtOffset(
      0,
      DISPLAY_COUNT);
    const result = messages.slice().reverse().map((message) => {
      return this.displayMessage(message);
    });

    console.log('\x1b[2J');
    console.log(`===== ${this.channel.name} ` +
      `${bs58.encode(this.channel.publicKey)} =====`);

    console.log(result.join('\n'));
    console.log(`===== ${this.channel.name} =====`);

    this.repl.displayPrompt(true);
  }

  displayMessage(message) {
    let { publicKeys, displayPath } = message.getAuthor(this.channel);

    displayPath = displayPath.map((name, i) => {
      // Make last element of path bold
      if (i === displayPath.length - 1) {
        name = '\x1b[1m' + name;
      }

      // Colorize peers by key
      const [ r, g, b ] = publicKeys[i].slice(0, 3);
      name = `\x1b[38;2;${r};${g};${b}m` + name;

      // Reset color
      name +='\x1b[0m';

      return name;
    });
    const time = new Date(message.timestamp * 1000).toLocaleTimeString();
    const author = displayPath.join('>');

    let text;
    if (message.isRoot) {
      text = '<root>';
    } else {
      text = message.json.text;
    }
    return `(${message.height}) ${time} [${author}]: ${text}`;
  }
}
