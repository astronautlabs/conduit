import { Subject } from "rxjs";
import { RPCChannel } from "./channel";

export class TestChannel implements RPCChannel {
    private _received = new Subject<string>();
    get received() { return this._received.asObservable(); }

    send(message: string) {
        setTimeout(() => {
            this.otherChannel.receive(message);
        }, this.sendDelay);
    }

    /**
     * How long do you want messages received to be delayed by.
     */
    receiveDelay = 0;
    sendDelay = 0;

    private receive(message: string) {
        setTimeout(() => {
            this._received.next(message);
        }, this.receiveDelay);
    }
    
    private otherChannel: TestChannel;

    static makePair(): [ TestChannel, TestChannel ] {
        let a = new TestChannel();
        let b = new TestChannel();

        a.otherChannel = b;
        b.otherChannel = a;

        return [a, b];
    }
}
