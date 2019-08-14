import { Buffer } from 'buffer';

import hyperswarm from 'hyperswarm';

import Protocol, { Channel, Message, Peer, StreamSocket } from '../../..';

const DISPLAY_COUNT = 10;

export default class Chat {
  constructor(repl) {
    this.swarm = hyperswarm();
    this.protocol = new Protocol();
    this.identity = null;
    this.channel = null;

    this.decryptInvite = null;
  }

  async iam(name) {
    if (!name) {
      throw new Error('Usage: iam([ name ])');
    }
    this.identity = await this.protocol.createIdentity(name);
    this.channel = this.protocol.getChannel(name);

    this.swarm.join(this.channel.id, {
      lookup: true,
      announce: true,
    });

    this.swarm.on('connection', (socket) => {
      this.onConnection(socket);
    });

    return `Created identity: "${name}"`;
  }

  async requestInvite() {
    if (!this.identity) {
      throw new Error('`.iam()` must be called first');
    }

    const { request, decrypt } = this.identity.requestInvite(
      this.protocol.id);

    this.decryptInvite = decrypt;

    console.log('Ask you peer to run:');
    console.log('issueInvite(' +
      JSON.stringify(request.toString('base64')) +
      ')');
    return '(generated invite request)';
  }

  async issueInvite(request) {
    if (!this.identity) {
      throw new Error('`.iam()` must be called first');
    }
    if (!request) {
      throw new Error('Usage: issueInvite([ base64 request string])');
    }

    request = Buffer.from(request, 'base64');
    const { encryptedInvite } = this.identity.issueInvite(
      this.channel, request);
    const json = JSON.stringify({
      requestId: encryptedInvite.requestId.toString('base64'),
      box: encryptedInvite.box.toString('base64'),
    });

    console.log('Ask invitee to run:');
    console.log(`join(${json})`);

    return '(issued invite)';
  }

  async join(invite) {
    if (!this.identity) {
      throw new Error('`.iam()` must be called first');
    }
    if (!invite || !invite.requestId || !invite.box || !this.decryptInvite) {
      throw new Error(
        'Ask your peer for an invite first with `requestInvite()`');
    }

    invite = {
      requestId: Buffer.from(invite.requestId, 'base64'),
      box: Buffer.from(invite.box, 'base64'),
    };
    invite = this.decryptInvite(invite);
    const channel = await Channel.fromInvite(invite, this.identity);

    // Join channel's swarm to start synchronization
    this.swarm.leave(this.channel.id);
    for (const socket of this.swarm.connections) {
      socket.destroy();
    }

    this.channel = channel;
    this.swarm.join(this.channel.id, {
      lookup: true,
      announce: true,
    });

    return `Joined channel: "${this.channel.name}"`;
  }

  async post(text) {
    if (!this.identity) {
      throw new Error('`.iam()` must be called first');
    }

    const body = Message.json(JSON.stringify({ text }));
    const message = await this.channel.post(body, this.identity);

    await this.displayChannel();
    return '(successfully posted message)';
  }

  async displayChannel() {
    const count = await this.channel.getMessageCount();

    const result = [];
    for (let i = Math.max(0, count - DISPLAY_COUNT); i < count; i++) {
      const message = await this.channel.getMessageAtOffset(i);
      result.push(this.displayMessage(message));
    }
    return result.join('\n');
  }

  displayMessage(message) {
    const author = message.getAuthor(this.channel).toString('hex').slice(0, 8);
    const body = message.content.body;

    let text;
    if (body.root) {
      text = '<root>';
    } else {
      text = JSON.parse(body.json).text;
    }
    return `(${message.height}) [${author}]: ${text}`;
  }

  // Networking

  onConnection(stream) {
    const socket = new StreamSocket(stream);

    this.protocol.connect(socket).catch((e) => {
      console.error(e.stack);
    });
  }
}
