import jsQR from "jsqr-es6"; 

/* eslint-disable-next-line no-restricted-globals */
const ctx: Worker = self as any;

ctx.addEventListener('message', function(e) {
 
    const type = e['data']['type'];
    const data = e['data']['data'];

    switch (type) {
        case 'decode':
            decode(data);
            break;
        case 'close':
            // close after earlier messages in the event loop finished processing
            /* eslint-disable-next-line no-restricted-globals */
            self.close();
            break;
    }
  });

function decode(data:any) {
    const rgbaData = data['data'];
    const width = data['width'];
    const height = data['height'];
    const result = jsQR(rgbaData, width, height);

    //@ts-ignore
    postMessage({
        type: 'qrResult',
        data: result? result.data : null,
    });
}

class WebpackWorker extends Worker {
  constructor(){ super("") }
}

export default WebpackWorker