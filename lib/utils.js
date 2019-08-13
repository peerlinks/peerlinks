export function now() {
  return Date.now() / 1000;
}

export class WaitList {
  constructor() {
    this.map = new Map();
  }

  wait(id) {
    let elem = null;
    return {
      promise: new Promise((resolve, reject) => {
        elem = {
          resolve: (result) => {
            this.map.delete(id);
            resolve(result);
          },
          reject: (error) => {
            this.map.delete(id);
            reject(error);
          }
        };
        this.map.set(id, elem);
      }),
      cancel: () => {
        if (!this.map.has(id)) {
          return;
        }

        elem.reject(new Error('Cancelled'));
      }
    };
  }

  resolve(id, result) {
    if (!this.map.has(id)) {
      return;
    }

    this.map.get(id).resolve(result);
  }

  static resolve(value) {
    return { promise: Promise.resolve(value), cancel() {} };
  }
}
