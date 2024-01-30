import { delay, describe } from "razmin";
import { Method } from "./method";
import { Remotable } from "./remotable";
import { Name } from "./name";
import { Service } from "./service";
import { expect } from "chai";
import { Event } from "./event";
import { Subject } from "rxjs";
import { RPCSession } from "./session";
import { Proxied } from "./proxied";
import { TestChannel } from "./test-channel";
import { RPCInternalError, raise } from "./errors";
import { RPCLogOptions } from "./logger";

describe('RPCSession', it => {
    function sessionPair(options: { safeExceptionsMode?: boolean, maskStackTraces?: boolean, addCallerStackTraces?: boolean } = {}) {
        let [channelA, channelB] = TestChannel.makePair();
        let sessionA = new RPCSession(channelA);
        let sessionB = new RPCSession(channelB);

        sessionA.tag = 'A';
        sessionB.tag = 'B';

        Object.assign(sessionA, options);
        Object.assign(sessionB, options);

        return [sessionA, sessionB];
    }

    it('can accept abstract classes', async () => {
        let [sessionA, sessionB] = sessionPair();

        @Name('com.example.A')
        abstract class A extends Service {
            abstract info(): Promise<string>;
        }

        class AImpl extends A {
            @Method()
            async info() {
                return 'this is A';
            }
        }

        sessionA.registerService(AImpl);

        let aProxy = await sessionB.getRemoteService(A);
        let str = await aProxy.info();
        expect(str).to.equal('this is A');
    });

    it('performs simple method calls', async () => {
        let [sessionA, sessionB] = sessionPair();
        let received = '';

        @Remotable()
        class CallbackB {
            @Method()
            async callback(message: string) {
                received += message;
            }
        }

        @Name('org.webrpc.A')
        class A extends Service {
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

    it('Translates standard exceptions appropriately', async () => {
        let [sessionA, sessionB] = sessionPair({ safeExceptionsMode: false, maskStackTraces: false, addCallerStackTraces: false });
        
        @Name('org.webrpc.A')
        class A extends Service {
            @Method() async EvalError() { throw new EvalError(); }
            @Method() async RangeError() { throw new RangeError(); }
            @Method() async ReferenceError() { throw new ReferenceError(); }
            @Method() async SyntaxError() { throw new SyntaxError(); }
            @Method() async TypeError() { throw new TypeError(); }
            @Method() async URIError() { throw new URIError(); }
        }

        sessionA.registerService(A);
        let serviceA: Proxied<A> = await sessionB.getRemoteService('org.webrpc.A');

        expect(await serviceA.EvalError().catch(e => e)).to.be.instanceOf(EvalError);
        expect(await serviceA.RangeError().catch(e => e)).to.be.instanceOf(RangeError);
        expect(await serviceA.ReferenceError().catch(e => e)).to.be.instanceOf(ReferenceError);
        expect(await serviceA.SyntaxError().catch(e => e)).to.be.instanceOf(SyntaxError);
        expect(await serviceA.TypeError().catch(e => e)).to.be.instanceOf(TypeError);
        expect(await serviceA.URIError().catch(e => e)).to.be.instanceOf(URIError);
    });

    it('Preserves exception properties', async () => {
        let [sessionA, sessionB] = sessionPair({ safeExceptionsMode: false, maskStackTraces: false, addCallerStackTraces: false });
        let error = new TypeError();

        @Name('org.webrpc.A')
        class A extends Service {
            @Method() async raise() { throw error; }
        }

        sessionA.registerService(A);
        let serviceA: Proxied<A> = await sessionB.getRemoteService('org.webrpc.A');

        let error2 = await serviceA.raise().catch(e => e);

        expect(error).not.to.equal(error2); // should not be reference equal
        expect(error2.stack).to.equal(error.stack);
        expect(error2.name).to.equal(error.name);
        expect(error2.message).to.equal(error.message);
    });

    it('Preserves throwable properties', async () => {
        let [sessionA, sessionB] = sessionPair({ safeExceptionsMode: false, maskStackTraces: false, addCallerStackTraces: false });
        let error = { foo: 123, bar: 321 };

        @Name('org.webrpc.A')
        class A extends Service {
            @Method() async raise() { throw error; }
        }

        sessionA.registerService(A);
        let serviceA: Proxied<A> = await sessionB.getRemoteService('org.webrpc.A');

        let error2 = await serviceA.raise().catch(e => e);

        expect(error).not.to.equal(error2); // should not be reference equal
        expect(error2).to.eql(error);
    });

    it('Preserves custom error properties', async () => {
        let [sessionA, sessionB] = sessionPair({ safeExceptionsMode: false, maskStackTraces: false, addCallerStackTraces: false });

        class CustomError extends Error {
            constructor(readonly foo: number, readonly bar: number) {
                super('Custom error has occurred');
            }
        }

        let error = new CustomError(123, 321);

        @Name('org.webrpc.A')
        class A extends Service {
            @Method() async raise() { throw error; }
        }

        sessionA.registerService(A);
        let serviceA: Proxied<A> = await sessionB.getRemoteService('org.webrpc.A');

        let error2 = await serviceA.raise().catch(e => e);

        expect(error).not.to.equal(error2); // should not be reference equal
        expect(error2.message).to.equal(error.message);
        expect(error2.stack).to.equal(error.stack);
        expect(error2.name).to.equal(error.name);
        expect(error2.foo).to.equal(error.foo);
        expect(error2.bar).to.equal(error.bar);
    });

    it('Serializes registered custom errors properly, even without specifying `name`', async () => {
        let [sessionA, sessionB] = sessionPair({ safeExceptionsMode: false, maskStackTraces: false, addCallerStackTraces: false });

        class CustomError extends Error {
            constructor(readonly foo: number, readonly bar: number) {
                super('Custom error has occurred');
            }
        }

        let error = new CustomError(123, 321);

        @Name('org.webrpc.A')
        class A extends Service {
            @Method() async raise() { throw error; }
        }

        sessionB.registerErrorType(CustomError);
        sessionA.registerService(A);
        let serviceA: Proxied<A> = await sessionB.getRemoteService('org.webrpc.A');

        let error2 = await serviceA.raise().catch(e => e);

        expect(error).not.to.equal(error2); // should not be reference equal
        expect(error2).to.be.instanceOf(CustomError);
        expect(error2.message).to.equal(error.message);
        expect(error2.stack).to.equal(error.stack);
        expect(error2.name).to.equal(error.name);
        expect(error2.foo).to.equal(error.foo);
        expect(error2.bar).to.equal(error.bar);
    });

    it('can mask stack traces', async () => {
        let [sessionA, sessionB] = sessionPair({ safeExceptionsMode: false, maskStackTraces: true, addCallerStackTraces: false });

        class CustomError extends Error {
            constructor(readonly foo: number, readonly bar: number) {
                super('Custom error has occurred\netc');
            }
        }

        let error = new CustomError(123, 321);

        @Name('org.webrpc.A')
        class A extends Service {
            @Method() async raise() { throw error; }
        }

        sessionA.registerService(A);
        let serviceA: Proxied<A> = await sessionB.getRemoteService('org.webrpc.A');

        let error2 = await serviceA.raise().catch(e => e);

        expect(error).not.to.equal(error2); // should not be reference equal
        expect(error2.stack).to.equal(`${error.name}: ${error.message}`);
    });    
    
    it('#safeExceptionsMode allows intentional exceptions through', async () => {
        let [sessionA, sessionB] = sessionPair({ safeExceptionsMode: true, maskStackTraces: false, addCallerStackTraces: false });

        class CustomError extends Error {
            constructor(readonly foo: number, readonly bar: number) {
                super('Custom error has occurred\netc');
            }
        }

        let error = new CustomError(123, 321);

        @Name('org.webrpc.A')
        class A extends Service {
            @Method() async raise() { raise(error); }
        }

        sessionA.registerService(A);
        let serviceA: Proxied<A> = await sessionB.getRemoteService('org.webrpc.A');

        let error2 = await serviceA.raise().catch(e => e);

        expect(error).not.to.equal(error2); // should not be reference equal
        expect(error2.stack).to.equal(error.stack);
    });
    
    it('#safeExceptionsMode intercepts unintentional exceptions', async () => {
        let [sessionA, sessionB] = sessionPair({ safeExceptionsMode: true, maskStackTraces: false, addCallerStackTraces: false });

        class CustomError extends Error {
            constructor(readonly foo: number, readonly bar: number) {
                super('Custom error has occurred\netc');
            }
        }

        let error = new CustomError(123, 321);

        @Name('org.webrpc.A')
        class A extends Service {
            @Method() async raise() { throw error; }
        }

        sessionA.registerService(A);
        let serviceA: Proxied<A> = await sessionB.getRemoteService('org.webrpc.A');

        let logs: { message: string, options: RPCLogOptions }[] = [];

        sessionA.logger = { 
            log: (message: string, options: RPCLogOptions) => {
                logs.push({ message, options });
            }
        };

        let error2 = await serviceA.raise().catch(e => e);

        expect(logs.length).to.equal(1);
        expect(logs[0].message).to.equal(`Error during A#raise(): ${error.stack}`);
        expect(error).not.to.equal(error2); // should not be reference equal
        expect(error2).to.be.instanceOf(RPCInternalError);
        expect(error2.stack).not.to.equal(error.stack);
        expect(error2.message).not.to.equal(error.message);
    });
    
    it('#addCallerStackTraces adds client stack tracing', async () => {
        let [sessionA, sessionB] = sessionPair({ safeExceptionsMode: false, maskStackTraces: false, addCallerStackTraces: true });

        class CustomError extends Error {
            constructor(readonly foo: number, readonly bar: number) {
                super('Custom error has occurred\netc');
            }
        }

        let error = new CustomError(123, 321);

        @Name('org.webrpc.A')
        class A extends Service {
            @Method() async raise() { throw error; }
        }

        sessionA.registerService(A);
        let serviceA: Proxied<A> = await sessionB.getRemoteService('org.webrpc.A');

        let logs: { message: string, options: RPCLogOptions }[] = [];

        sessionA.logger = { 
            log: (message: string, options: RPCLogOptions) => {
                logs.push({ message, options });
            }
        };

        let error2 = await serviceA.raise().catch(e => e);

        expect(error2.stack).includes('-- Client stack trace');
    });

    it('events work', async () => {
        let [sessionA, sessionB] = sessionPair();

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

        @Name('org.webrpc.A')
        class A extends Service {
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

    it('holds a remote reference to proxied objects', async () => {
        let [sessionA, sessionB] = sessionPair();

        @Remotable()
        class A2 {
            @Method() works() { return 'good!'; }
        }

        @Name('org.webrpc.A')
        class A extends Service {
            @Method()
            async doStuff() {
                return new A2();
            }
        }

        sessionA.registerService(A);
        let a = await sessionB.getRemoteService<A>('org.webrpc.A');
        expect(a).to.exist;
        let a2 = await a.doStuff();
        gc();
        expect(await a2.works()).to.equal('good!');
    });

    it('collapses duplicate references', async () => {
        let [sessionA, sessionB] = sessionPair();

        @Remotable()
        class A2 {
            @Method() works() { return 'good!'; }
        }

        @Name('org.webrpc.A')
        class A extends Service {
            a2 = new A2();
            @Method()
            async doStuff() {
                return this.a2;
            }
        }

        sessionA.registerService(A);
        let a = await sessionB.getRemoteService<A>('org.webrpc.A');
        expect(a).to.exist;
        let a2 = await a.doStuff();
        let id = sessionB.getObjectId(a2);
        expect(sessionA.countReferencesForObject(id)).to.equal(1);
        
        (sessionB.channel as TestChannel).receiveDelay = 100;
        setTimeout(() => {
            expect(sessionA.countReferencesForObject(id)).to.equal(2);
        }, 50)
        await a.doStuff();
        await delay(101);
        expect(sessionA.countReferencesForObject(id)).to.equal(1);
    });

    it('should release an object that is no longer referenced', async () => {
        let [sessionA, sessionB] = sessionPair();

        @Remotable()
        class A2 {
            @Method() works() { return 'good!'; }
        }

        let count = 0;
        let finalizer = new FinalizationRegistry(() => count += 1);

        @Name('org.webrpc.A')
        class A extends Service {
            @Method()
            async doStuff() {
                let a2 = new A2();
                finalizer.register(a2, 0);
                return a2;
            }
        }


        sessionA.registerService(A);
        let a = await sessionB.getRemoteService<A>('org.webrpc.A');
        expect(a).to.exist;

        let a2 = await a.doStuff();
        let id = sessionB.getObjectId(a2);
        // To simulate garbage collection
        sessionA.finalizeProxy(a2);
        
        await delay(10);
        expect(sessionA.countReferencesForObject(id)).to.equal(0);
    });

    it('handles garbage collection race conditions correctly', async () => {
        let [sessionA, sessionB] = sessionPair();

        @Remotable()
        class A2 {
            @Method() works() { return 'good!'; }
        }

        @Name('org.webrpc.A')
        class A extends Service {
            a2: WeakRef<A2>;

            @Method()
            async doStuff() {
                let a2 = this.a2?.deref();
                if (!a2)
                    this.a2 = new WeakRef(a2 = new A2());
                
                // (2)
                await delay(1000);
                // (4)
                return a2;
            }
        }

        sessionA.registerService(A);
        let a = await sessionB.getRemoteService<A>('org.webrpc.A');
        let a2 = await a.doStuff();
        let referenceId = sessionB.getReferenceId(a2);
        let objectId = sessionB.getObjectId(a2);

        expect(sessionA.countReferencesForObject(objectId), `Object ${objectId} should definitely have 1 reference here`).to.equal(1);
        expect(sessionA.isLocalObjectPresent(objectId), 'Should obviously be present here').to.be.true;
        
        setTimeout(async () => {
            // (3) Delay messages by a large amount to force the race condition
            (sessionB.channel as TestChannel).receiveDelay = 1500;
            await delay(500);

            // (5) Response should have been sent by now, but we've delayed handling it.
            //     We should have 2 references now.
            expect(sessionA.countReferencesForObject(objectId), 'After response sent').to.equal(2);

            // Call finalizeProxy() on our first reference.
            // Note that we cannot await the response as it is buffered _behind_ our pending operation.
            sessionA.finalizeProxy(a2); await delay(10);
            expect(sessionA.countReferencesForObject(objectId), 'After finalizing proxy').to.equal(1);

            expect(sessionA.countReferencesForObject(objectId), 'After garbage collection').to.equal(1);
            expect(sessionA.isLocalObjectPresent(objectId), 'Should still be present here after forcing race condition').to.be.true;
        }, 900);

        // (1) This call naturally takes 1000ms to complete, and we'll add 1500ms to its length artificially
        let a2_2 = await a.doStuff();
        expect(sessionA.countReferencesForObject(objectId), 'After garbage collection').to.equal(1);
        expect(sessionA.isLocalObjectPresent(objectId)).to.be.true;

        // At this point the setTimeout has run, a2 was vulnerable to garbage collection.
        // Make sure we've protected it from happening

        expect(await a2_2.works()).to.equal('good!');
    });
});