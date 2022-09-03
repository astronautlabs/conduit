import { delay, describe } from "razmin";
import { LocalChannel, Proxied, RPCSession } from ".";
import { Method } from "./method";
import { Remotable } from "./remotable";
import { Service } from "./service";
import { expect } from "chai";
import { Event } from "./event";
import { Subject } from "rxjs";

describe('RPCSession', it => {
    it('events work', async () => {
        let [channelA, channelB] = LocalChannel.makePair();
        let sessionA = new RPCSession(channelA);
        let sessionB = new RPCSession(channelB);

        sessionA.tag = 'A';
        sessionB.tag = 'B';

        let received = '';

        @Remotable()
        class CallbackB {
            @Method()
            async callback(message: string) {
                received += message;
            }
        }

        @Service('org.webrpc.A')
        class A {
            constructor() {
            }
            private _somethingHappened = new Subject<string>();
            @Event() get somethingHappened() { return this._somethingHappened.asObservable(); }

            @Method()
            async makeSomethingHappen() {
                this._somethingHappened.next(`Whoo!`);
            }
        }

        sessionA.registerService(A);

        let serviceA: Proxied<A> = await sessionB.getRemoteService('org.webrpc.A');
        expect(serviceA).to.exist;

        let observedThing: string = '';

        serviceA.somethingHappened.subscribe(thing => observedThing += thing);
        await serviceA.makeSomethingHappen();
        await delay(100);
        expect(observedThing).to.equal('Whoo!');
    });

    it('works', async () => {
        let [channelA, channelB] = LocalChannel.makePair();
        let sessionA = new RPCSession(channelA);
        let sessionB = new RPCSession(channelB);

        sessionA.tag = 'A';
        sessionB.tag = 'B';

        let received = '';

        @Remotable()
        class CallbackB {
            @Method()
            async callback(message: string) {
                received += message;
            }
        }

        @Service('org.webrpc.A')
        class A {
            @Method()
            async doStuff(callback: Proxied<CallbackB>) {
                await callback.callback("one|");
                await callback.callback("two|");
                await callback.callback("three|");
                return callback;
            }
        }

        sessionA.registerService(A);

        let serviceA: Proxied<A> = await sessionB.getRemoteService('org.webrpc.A');
        expect(serviceA).to.exist;

        let callbackB = new CallbackB();

        let result = await serviceA.doStuff(callbackB);

        expect(received).to.equal('one|two|three|');
        expect(result).to.equal(callbackB);
    });
});