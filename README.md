# @/webrpc

> 🚧 **Work In Progress**  
> This library is in an alpha state. It is not yet ready for production use.

> 📺 Part of the [**Astronaut Labs Broadcast Suite**](https://github.com/astronautlabs/broadcast)

[![NPM](https://img.shields.io/npm/v/@astronautlabs/webrpc.svg)](https://www.npmjs.com/package/@astronautlabs/webrpc) [![Build Status](https://circleci.com/gh/astronautlabs/webrpc/tree/main.svg?style=shield)](https://circleci.com/gh/astronautlabs/webrpc)

A powerful way to do RPC on the web.

```ts
import { RPCSession, LocalChannel, Method } from '@astronautlabs/webrpc';

let [channelA, channelB] = LocalChannel.makePair();

@Service('com.example.randomNumber')
class MyService {
    @Method()
    getRandomNumber() {
        return Math.random();
    }
}

let sessionA = new RPCSession(channelA);
sessionA.registerService(MyService);

// ---

let sessionB = new RPCSession(channelB);
let remoteObject = await session.getRemoteService(MyService);

let number = await remoteObject.getRandomNumber();
console.log(number);
```

# Object References

You aren't limited to singleton services with `@/webrpc`

```typescript
import { RPCSession, LocalChannel, Method, Remotable } from '@astronautlabs/webrpc';

let [channelA, channelB] = LocalChannel.makePair();

@Service('com.example.randomNumber')
class MyService {
    @Method()
    getRandomGenerator(min: number, max: number) {
        return new RandomGenerator(min, max);
    }
}

@Remotable()
class RandomGenerator {
    constructor(readonly min: number, max: number) {
    }

    @Method()
    random() {
        return min + Math.random() * (max - min) | 0;
    }
}

let sessionA = new RPCSession(channelA);
sessionA.registerService(MyService);

// ---

let sessionB = new RPCSession(channelB);
let remoteObject = await session.getRemoteService(MyService);

let generator = await remoteObject.getRandomGenerator(4, 8);
console.log(await generator.random()); // 6
console.log(await generator.random()); // 4
console.log(await generator.random()); // 7
console.log(await generator.random()); // 5
```

# Events

```typescript
import { RPCSession, LocalChannel, Event } from '@astronautlabs/webrpc';

let [channelA, channelB] = LocalChannel.makePair();

@Service('com.example.randomNumber')
class MyService {
    constructor() {
        setTimeout(() => this._timer.next(), 1000);
    }

    private _timer: Subject<void>;
    private _timerObservable: Observable<void>;

    @Event()
    get timer() { return this._timerObservable; }
}

let sessionA = new RPCSession(channelA);
sessionA.registerService(MyService);

// ---

let sessionB = new RPCSession(channelB);
let remoteObject = await session.getRemoteService(MyService);

let subscription = await remoteObject.timer.subscribe(() => console.log(`tick`));
setTimeout(async () => await subscription.unsubscribe(), 5*1000);

// console: tick
// console: tick
// console: tick
// console: tick
// console: tick
```

# Wire Format

`@/webrpc` encodes messages in JSON, making it ideal for use on the web. 

# Channels

You can use any kind of communication channel underneath an RPCSession. Several useful types are included:

* `SocketChannel` - Perform RPC over a WebSocket
* `WindowChannel` - Perform RPC between the current window and a remote window, such as an `<iframe>` or a popup
* `LocalChannel` - A simple two-sided in-memory channel that is good for testing.

You can implement your own custom channels by implementing the `RPCChannel` interface

```typescript
export interface RPCChannel {
    received: Observable<string>;
    send(message: string);
    close?();
}
```

# Garbage Collection

References to remote objects intelligently handle garbage collection. References on the remote side keep the objects they refer to on the local side alive (they won't be garbage collected). When remote references are discarded and get garbage collected, references on the server side are automatically discarded to allow objects to be garbage collected.

# Service Factories

By default service objects are created on-demand for a specific RPCSession and are not shared. You can however implement shared service objects by providing a custom "service factory"

```typescript
session.registerService(MyService, () => myServiceInstance); // where myServiceInstance is not specific to this session
```

Service factories are passed a single argument, the `RPCSession` that is responsible for creating them. This allows you easy access to the related session if you need it.

```typescript
session.registerService(MyService, session => new MyService(session));
```

Since service factories are just functions, you could use this to add dependency injection.

# Services without registration

If you wish to dynamically create services with arbitrary logic, you can subclass `RPCSession`

```typescript

class MySession extends RPCSession {
    @Method()
    override getLocalService(identity: string) {
        // Add arbitrary logic for creating service objects here
        return new MyService();
    }
}
```