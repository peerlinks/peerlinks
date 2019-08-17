import * as repl from 'repl';
import * as vm from 'vm';

import Storage from '@vowlink/sqlite-storage';

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
    console.log('  iam(\'name\') - create new or select existing ' +
      'identity+channel');
    console.log('  setChannel(\'channel name\') - set current channel');
    console.log('  post(\'message text\') - post message to current channel');
    console.log('  requestInvite() - request an invite to new channel');
    console.log('  identities() - list available identities');
    console.log('  channels() - list available channels');
    return '(help end)';
  };

  [
    'iam',
    'post',
    'requestInvite',
    'issueInvite',

    'identities',
    'channels',
    'setChannel',
  ].forEach(expose);
}

main().catch((e) => {
  console.error(e.stack);
});
