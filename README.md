# @/webrpc

> 🚧 **Work In Progress**  
> This library is in an alpha state. It is not yet ready for production use.

> 📺 Part of the [**Astronaut Labs Broadcast Suite**](https://github.com/astronautlabs/broadcast)

[![NPM](https://img.shields.io/npm/v/@astronautlabs/webrpc.svg)](https://www.npmjs.com/package/@astronautlabs/webrpc) [![Build Status](https://circleci.com/gh/astronautlabs/webrpc/tree/main.svg?style=shield)](https://circleci.com/gh/astronautlabs/webrpc)

A powerful way to do RPC on the web.

```ts
import { RPCSession, LocalChannel, Method } from '@astronautlabs/webrpc';

let [channelA, channelB] = LocalChannel.makePair();

@Service('com.exmple.randomNumber')
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