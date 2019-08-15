import * as repl from 'repl';
import * as vm from 'vm';

import Storage from 'vowlink-sqlite-storage';

import Chat from '../';

async function main() {
  const io = repl.start({
    eval(cmd, context, _, callback) {
      const promise = vm.runInContext(cmd, context);
      if (promise && promise.then) {
        promise.then((answer) => callback(null, answer));
      } else {
        callback(null, promise);
      }
    }
  });

  const storage = new Storage({
    file: 'chat.sqlite',
    trace: !!process.env.VOWLINK_TRACE_DB,
  });

  await storage.open();

  io.on('exit', () => {
    console.log('Saving...');
    storage.close().then(() => {
      process.exit(0);
    });
  });

  const chat = new Chat(io, storage);

  await chat.load();

  function expose(method) {
    io.context[method] = async (...args) => {
      try {
        return await chat[method](...args);
      } catch (err) {
        console.error('Error: ' + err.stack);
        return '(error)';
      }
    };
  }

  io.context.help = () => {
    console.log('Available commands:');
    console.log('  iam(\'name\')');
    console.log('  post(\'message text\')');
    console.log('  requestInvite()');
    console.log('  identities()');
    console.log('  channels()');
    console.log('  setChannel(\'channel name\')');
    return '(help end)';
  };

  [
    'iam',
    'post',
    'requestInvite',
    'issueInvite',
    'join',

    'identities',
    'channels',
    'setChannel',
  ].forEach(expose);
}

main().catch((e) => {
  console.error(e.stack);
});
