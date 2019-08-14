import * as repl from 'repl';
import * as vm from 'vm';

import Chat from '../';

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

const chat = new Chat(io);

function expose(method) {
  io.context[method] = async (...args) => {
    try {
      return await chat[method](...args);
    } catch (err) {
      return 'Error: ' + err.message;
    }
  };
}

[
  'iam',
  'post',
  'requestInvite',
  'issueInvite',
  'join',
].forEach(expose);
