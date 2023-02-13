import { Observable, Subject } from "rxjs";
import { take } from "rxjs/operators";
import { DurableSocket } from "./durable-socket";
import { ResettableReplaySubject } from "./resettable-subject";

export interface RPCChannel {
    received: Observable<string>;

    /**
     * This optional event signifies that the ongoing state of the channel has been lost, 
     * and any outstanding requests are no longer resolvable. An example of such 
     * an event might be the connection being lost.
     * 
     * The value of the observable is the error message when state has been lost.
     */
    stateLost?: Observable<string>;

    /**
     * This optional event signifies that the channel is ready for communications. 
     * 
     * If provided, then this event must fire as soon as the channel is ready for use 
     * (even if the subscription occurs after the channel becomes ready for use). 
     * 
     * If the channel supports re-establishment, then subscribing to this 
     * observable while re-establishment is occuring must not cause an event until 
     * the channel is re-established.
     */
    ready?: Observable<void>;
    send(message: string);
    close?();
}

/**
 * A channel which operates within the local process.
 */
export class LocalChannel implements RPCChannel {
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

/**
 * A channel that operates over a WebSocket or RTCDataChannel.
 */
export class SocketChannel implements RPCChannel {
    constructor(readonly socket: WebSocket | RTCDataChannel) {
        if (socket.readyState === WebSocket.OPEN) {
            this.markReady();
        } else {
            socket.addEventListener('open', () => this.markReady());
        }
        socket.addEventListener('message', (ev: MessageEvent<any>) => this._received.next(ev.data));
        socket.addEventListener('close', () => this.stateWasLost(`Disconnected permanently`));
        socket.addEventListener('error', () => this.stateWasLost(`Disconnected permanently`));
    }

    private _ready = new ResettableReplaySubject<void>(1);
    get ready() { return this._ready.asObservable(); }

    markReady() {
        this._ready.next();
    }

    markNotReady() {
        this._ready.reset();
    }

    private _stateLost = new Subject<string>();
    private _stateLost$ = this._stateLost.asObservable();
    get stateLost() { return this._stateLost$; }

    private _received = new Subject<string>();
    private _received$ = this._received.asObservable();
    get received() { return this._received$; }

    protected stateWasLost(errorMessage: string) {
        this._stateLost.next(errorMessage);
    }

    async send(message: any) {
        await this.ready.pipe(take(1)).toPromise();
        this.socket.send(message)
    }

    close() {
        this.socket.close();
    }
}

/**
 * A channel that operates on a DurableSocket.
 */
export class DurableSocketChannel extends SocketChannel {
    constructor(socket: DurableSocket) {
        super(socket);
        socket.addEventListener('lost', () => (this.markNotReady(), this.stateWasLost(`Connection lost`)));
        socket.addEventListener('restore', () => this.markReady());
    }

    readonly socket: DurableSocket;
}

/**
 * A channel that operates via window-to-window (or frame-to-frame) postMessage.
 */
export class WindowChannel implements RPCChannel {
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
