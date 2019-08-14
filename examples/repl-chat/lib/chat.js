import { Buffer } from 'buffer';

import hyperswarm from 'hyperswarm';

import Protocol, {
  Channel,
  Message,
  Peer,
  StreamSocket,
} from 'vowlink-protocol';

const DISPLAY_COUNT = 10;

export default class Chat {
  constructor(repl) {
    this.repl = repl;
    this.repl.setPrompt('> ');
    this.repl.displayPrompt();

    this.swarm = hyperswarm();
    this.protocol = new Protocol();
    this.identity = null;
    this.channel = null;

    this.decryptInvite = null;

    this.swarm.on('connection', (socket) => {
      this.onConnection(socket);
    });
  }

  async iam(name) {
    if (!name) {
      throw new Error('Usage: iam([ name ])');
    }
    this.identity = await this.protocol.createIdentity(name);
    this.setChannel(this.protocol.getChannel(name));

    return `Created identity: "${name}"`;
  }

  async requestInvite() {
    if (!this.identity) {
      throw new Error('`iam()` must be called first');
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
      throw new Error('`iam()` must be called first');
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
      throw new Error('`iam()` must be called first');
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
    await this.protocol.addChannel(channel);

    // Join channel's swarm to start synchronization
    this.setChannel(channel);

    return `Joined channel: "${this.channel.name}"`;
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

  async displayChannel() {
    const count = await this.channel.getMessageCount();

    const result = [];
    for (let i = Math.max(0, count - DISPLAY_COUNT); i < count; i++) {
      const message = await this.channel.getMessageAtOffset(i);
      result.push(this.displayMessage(message));
    }

    console.log('===== CHANNEL UPDATE =====');
    console.log(result.join('\n'));
    console.log('===== CHANNEL UPDATE END =====');

    this.repl.displayPrompt(true);
  }

  displayMessage(message) {
    const author = message.getAuthor(this.channel).displayPath.join('>');
    const body = message.content.body;

    let text;
    if (body.root) {
      text = '<root>';
    } else {
      text = JSON.parse(body.json).text;
    }
    return `(${message.height}) [${author}]: ${text}`;
  }

  setChannel(channel) {
    if (this.channel) {
      this.swarm.leave(this.channel.id);
      for (const socket of this.swarm.connections) {
        socket.destroy();
      }
    }

    const onMessage = () => {
      this.displayChannel().catch(() => {});
      channel.waitForIncomingMessage().promise.then(onMessage);
    };

    channel.waitForIncomingMessage().promise.then(onMessage);

    this.channel = channel;
    this.swarm.join(this.channel.id, {
      lookup: true,
      announce: true,
    });
  }

  // Networking

  onConnection(stream) {
    const socket = new StreamSocket(stream);

    this.protocol.connect(socket).catch((e) => {
      console.error(e.stack);
    });
  }
}
