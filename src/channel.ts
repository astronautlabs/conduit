import { Observable, Subject } from "rxjs";

export interface Channel {
    received: Observable<string>;
    send(message: string);
    close?();
}

export class LocalChannel implements Channel {
    private _received = new Subject<string>();
    get received() { return this._received.asObservable(); }

    send(message: string) {
        this.otherChannel._received.next(message);
    }
    
    private otherChannel: LocalChannel;

    static makePair(): [ LocalChannel, LocalChannel ] {
        let a = new LocalChannel();
        let b = new LocalChannel();

        a.otherChannel = b;
        b.otherChannel = a;

        return [a, b];
    }
}

export class SocketChannel implements Channel {
    constructor(private socket: WebSocket | RTCDataChannel) {
        socket.addEventListener('message', (ev: MessageEvent<any>) => this._received.next(ev.data));
    }

    private _received = new Subject<string>();
    get received() { return this._received.asObservable(); }

    send(message: any) {
        this.socket.send(message)
    }

    close() {
        this.socket.close();
    }
}

export class WindowChannel implements Channel {
    constructor(private remoteWindow: Window, origin?: string) {
        window.addEventListener('message', this.handler = ev => {
            if (origin && ev.origin !== origin)
                return;
            this._received.next(ev.data)
        });
    }

    private handler;
    private _received = new Subject<string>();
    get received() { return this._received.asObservable(); }

    send(message: any) {
        this.remoteWindow.postMessage(message, '*');
    }

    close() {
        window.removeEventListener('message', this.handler);
    }
}
