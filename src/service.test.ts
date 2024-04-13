import { describe, it, jest } from "@jest/globals";
import { Service, createServiceProxy } from "./service";
import { RPCSession } from "./session";
import { expect } from "chai";
import { BehaviorSubject, NEVER, Observable, Subject, Subscription, delay } from "rxjs";
import { RPCChannel } from "./channel";
import { delay as delayPromise } from "./delay";
import { Constructor } from "./internal";
import { EventsOf, MethodsOf, Proxied } from "./proxied";
import { ResettableReplaySubject } from "./resettable-subject";

jest.setTimeout(30_000);

describe('createServiceProxy', () => {
    it('relays calls', async () => {
        let called = 0;
        class MyService extends Service {
            async thing() {
                await delayPromise(500);
                called += 1;
                return 'foobar';
            }
        }

        let returned = await serviceFixture(MyService).thing();
        expect(returned).to.equal('foobar');
        expect(called).to.equal(1);
    });
    it('delays calls until session is resolved', async () => {
        let called = 0;
        class MyService extends Service {
            async thing(): Promise<void> {
                await delayPromise(500);
                called += 1;
            }
        }

        await serviceFixture(MyService, { session: delayPromise(500).then(() => mockSession(MyService)) })
            .thing();
        expect(called).to.equal(1);
    });
    it('delays calls until channel is ready', async () => {

        let called = 0;
        class MyService extends Service {
            async thing(): Promise<void> {
                await delayPromise(500);
                called += 1;
            }
        }

        let proxy = serviceFixture(
            MyService,
            {
                session: mockSession(MyService, mockChannel({ 
                    ready: new BehaviorSubject<void>(undefined).pipe(delay(500)) 
                }))
            });

        await proxy.thing();
        expect(called).to.equal(1);
    });
    it('successfully relays event subscriptions', async () => {
        let called = 0;
        class MyService extends Service {
            event = mockObservable((observer: (value: string) => void) => {
                called += 1;
                return { unsubscribe() { } };
            })
        }

        await serviceFixture(MyService).event.subscribe(() => {});
        expect(called).to.equal(1);
    });
    it('successfully resubscribes after state loss', async () => {
        let subscribed = 0;
        let doStuff = 0;
        class MyService extends Service {
            event = mockObservable((observer: (value: string) => void) => {
                subscribed += 1;
                return { unsubscribe() { } };
            })

            async doStuff() {
                await delayPromise(500);
                doStuff += 1;
            }
        }

        let ready = new ResettableReplaySubject<void>(1);
        let stateLost = new Subject<string>();


        let proxy = serviceFixture(
            MyService,
            {
                session: mockSession(MyService, mockChannel({ ready, stateLost }))
            });

        let pendingSubscription = proxy.event.subscribe(() => {});
        let subscriptionResolved = false;
        pendingSubscription.then(() => subscriptionResolved = true);

        expect(subscribed).to.equal(0);
        ready.next();
        await delayPromise();
        expect(subscriptionResolved).to.be.true;
        expect(subscribed).to.equal(1);

        // Disconnect
        ready.reset();
        stateLost.next('Disconnected from service');
        expect(subscribed).to.equal(1);
        await delayPromise(100);
        expect(subscribed).to.equal(1);
        ready.next();
        await delayPromise();
        expect(subscribed).to.equal(2);
        
        // Disconnect #2
        ready.reset();
        stateLost.next('Disconnected from service');
        expect(subscribed).to.equal(2);
        await delayPromise(100);
        expect(subscribed).to.equal(2);
        ready.next();
        await delayPromise();
        expect(subscribed).to.equal(3);
    });
});

function mock<T>(partial: Partial<T>): T {
    return <T>partial;
}

async function mockSession(klass: Constructor<any>, channel?: RPCChannel) {
    return mock<RPCSession>({
        async getRemoteService(...args: any[]): Promise<any> {
            return new klass();
        },

        channel: channel ?? mockChannel()
    });
}

function mockChannel(channel: Partial<RPCChannel> = {}): RPCChannel {
    return <RPCChannel><Partial<RPCChannel>>{
        ready: new BehaviorSubject<void>(undefined),
        stateLost: NEVER,
        ...channel
    };
}

function mockObservable<T>(subscribe: (observer: (value: T) => void) => { unsubscribe(): void }): Observable<T> {
    return <Observable<T>> { subscribe };
}

function serviceFixture<T extends object>(klass: Constructor<T>, options: { session?: Promise<RPCSession>, channel?: RPCChannel } = {}): Proxied<T> {
    return createServiceProxy<T>(
        options.session ?? mockSession(klass, options.channel),
        klass
    );
}