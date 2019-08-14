import * as repl from 'repl';
import * as vm from 'vm';

import Chat from '../';

const chat = new Chat();

const io = repl.start({
  prompt: '> ',
  eval(cmd, context, _, callback) {
    const promise = vm.runInContext(cmd, context);
    if (promise && promise.then) {
      promise.then((answer) => callback(null, answer));
    } else {
      callback(null, promise);
    }
  }
});

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
