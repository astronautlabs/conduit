# ![@/conduit](./logo.svg)

> 🚧 **Beta Quality**  
> This library is in a beta state. It is stable and has been tested in many real world scenarios. 
> We do not yet recommend it for production use.

[![NPM](https://img.shields.io/npm/v/@astronautlabs/conduit.svg)](https://www.npmjs.com/package/@astronautlabs/conduit) 
[![Build Status](https://circleci.com/gh/astronautlabs/conduit/tree/main.svg?style=shield)](https://circleci.com/gh/astronautlabs/conduit)

A powerful way to do RPC on the web.

# Installation

```bash
npm install @astronautlabs/conduit
```

# Usage

We'll use Conduit for simple client/server RPC on the web. Conduit is not constrained to this use case, but it is 
the most common, and the path we recommend considering first.

First, create your interface layer. This will be consumed by both your client and server code:

```ts
import * as conduit from '@astronautlabs/conduit';

@conduit.Name('com.example.todo')
@conduit.URL('wss://example.com')
export class TodoService extends Service {
  abstract changed: Observable<Todo[]>;
  abstract add(todoInit: TodoInit): Promise<Todo>;
  abstract remove(todo: Todo): Promise<void>;
  abstract markDone(todo: Todo): Promise<Todo>;
}

export interface Todo {
  id: number;
  text: string;
  createdAt: number;
  done: boolean;
}

export type TodoInit = Omit<Todo, 'createdAt' | 'done' | 'id'>;

```

In your server:

```ts
import { BehaviorSubject } from 'rxjs';
import * as conduit from '@astronautlabs/conduit';
import * as Interface from '<my-service-interface>';

class TodoService extends Interface.TodoService {
  private todos: Interface.Todo[] = [];

  @conduit.Event() changed = new BehaviorSubject<Interface.Todo[]>();

  @conduit.Method()
  override add(todoInit: Interface.TodoInit) {
    let todo: Todo = {
      ...todoInit,
      id: this.todos.length,
      createdAt: Date.now(),
      done: false
    };

    this.todos.push(todo);
    this.changed.next(this.todos);
  }

  @conduit.Method()
  override remove(todo: Todo) {
    this.todos = this.todos.filter(x => x.id !== todo.id);
    this.changed.next(this.todos);
  }

  @conduit.Method() 
  override markDone(todo: Todo): Promise<Todo> {
    todo = this.todos.find(x => x.id === todo.id);
    if (!todo)
      conduit.raise(`No such Todo with ID ${todo.id}`);
    todo.done = true;
    this.changed.next(this.todos);
  }
}
```

In your client:

```ts
import { TodoService } from '<my-service-interface>';

const todos = TodoService.proxy();

todos.changed.subscribe(todos => {
  console.log(`todos changed: `, todos);
});

todos.add({ text: 'Finish the TODO app' });
```

## How should I structure my project?

There are many valid answers to the question of where your interface and server components should live within your 
codebase. You can consider this section a light recommendation on how you might structure your project.

Given a project which has a frontend, an interface, and a backend, you might arrange your project like this:

```
packages/
  frontend/
    package.json   # named "myproject-frontend", depends on "myproject"
    main.ts        # imports "myproject", which is the interface layer
    ...
  backend/
    package.json   # named "myproject", entrypoint ("main"/"module") is dist/interface/index.js
                   # start script runs your server
    .npmignore     # (only if you are going to actually publish to NPM) ignore "src/server", "dist/server" etc
    src/
      interface/   # contains interface definitions
        index.ts
        ...
      server/
        main.ts    # contains your server, import "../interface"
```

In the above we're assuming you are using `dist` as your Typescript output folder, obviously adjust as needed if you 
use `build` or something else as your output folder.

The above structure has a few nice benefits:
- The interface lives with the backend, which implements it
- The frontend, which is never a "library" for another piece of software, is called "PROJECT-frontend", whereas the 
  backend, which *can* be a library for another piece of software (your frontend) is called "PROJECT" (without the 
  "-backend" suffix). This also extends to microservices: If you had a `users` package, it would have the NPM name `PROJECT-users`, and other services which needed to talk to it would import it as such.
- If needed, this structure is prepared for publishing your API interfaces to NPM (you would simply configure `.npmignore` to omit your server side implementation and any other irrelevant content).

# Low Level API

Conduit also provides a low-level API without asserting any opinions. Using this mode opens up many more use cases, but
can be difficult to use correctly and error-prone. Please do not use this for standard client/server RPC, as the 
Conduit Services abstraction shown above handles a great deal of this difficulty for you.

```ts
import * as conduit from '@astronautlabs/conduit';

let [channelA, channelB] = conduit.LocalChannel.makePair();

@conduit.Name('com.example.randomNumber')
class MyService {
    @conduit.Method()
    getRandomNumber() {
        return Math.random();
    }
}

let sessionA = new conduit.RPCSession(channelA);
sessionA.registerService(MyService);

// ---

let sessionB = new conduit.RPCSession(channelB);
let remoteObject = await session.getRemoteService(MyService);

let number = await remoteObject.getRandomNumber();
console.log(number);
```

# Object References

You aren't limited to singleton services with `@/conduit`

```typescript
import * as conduit from '@astronautlabs/conduit';

let [channelA, channelB] = conduit.LocalChannel.makePair();

@conduit.Name('com.example.randomNumber')
class MyService {
    @conduit.Method()
    getRandomGenerator(min: number, max: number) {
        return new RandomGenerator(min, max);
    }
}

@conduit.Remotable()
class RandomGenerator {
    constructor(readonly min: number, max: number) {
    }

    @conduit.Method()
    random() {
        return min + Math.random() * (max - min) | 0;
    }
}

let sessionA = new conduit.RPCSession(channelA);
sessionA.registerService(MyService);

// ---

let sessionB = new conduit.RPCSession(channelB);
let remoteObject = await session.getRemoteService(MyService);

let generator = await remoteObject.getRandomGenerator(4, 8);
console.log(await generator.random()); // 6
console.log(await generator.random()); // 4
console.log(await generator.random()); // 7
console.log(await generator.random()); // 5
```

# Events

```typescript
import * as conduit from '@astronautlabs/conduit';

let [channelA, channelB] = conduit.LocalChannel.makePair();

@conduit.Name('com.example.randomNumber')
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

let sessionB = new conduit.RPCSession(channelB);
let remoteObject = await session.getRemoteService(MyService);

let subscription = await remoteObject.timer.subscribe(() => console.log(`tick`));
setTimeout(async () => await subscription.unsubscribe(), 5*1000);

// console: tick
// console: tick
// console: tick
// console: tick
// console: tick
```

# Channels

You can use any kind of communication channel underneath an RPCSession. Some channel types are included:

* `SocketChannel` - Perform RPC over a WebSocket
* `WindowChannel` - Perform RPC between the current window and a remote window, such as an `<iframe>` or a popup
* `LocalChannel` - A simple two-sided in-memory channel that is good for testing.

Since RPC over WebSockets is so common, it is made especially convenient:

```typescript
let session = await RPCSession.connect(`wss://example.com/my/socket`);
```

When the promise returned by `connect()` resolves the connection is fully established and ready for communication. If a 
connection error occurs, the promise will reject.

---

You can implement your own custom channels by implementing the `RPCChannel` interface

```typescript
export interface RPCChannel {
    received: Observable<string>;
    send(message: string);
    close?();
}
```

# Services

The primary purpose of Conduit is to expose service objects with well-known identities which have well-known interfaces.
From a developer experience perspective, you need only use `registerService` and `getRemoteService()` to register 
service classes of your own and consume methods of the remote service you are talking to. Remember that Conduit is 
bidirectional, and services can be registered on either side. It is totally possible (and sometimes desirable) for a 
WebSocket *client* to register a named service, and for the WebSocket *server* to acquire an instance of that service 
and call RPC methods on it.

For those interested in the mechanics of how this works, the local `RPCSession` implements 
`async getRemoteService(serviceName)` as `await this.remote.getLocalService(serviceName)`, where `this.remote` is the 
RPC proxy of the remote `RPCSession`. So there is no special mechanics for service discovery, these are just well known 
RPC calls of the `RPCSession` class.

# Service Factories

While it is possible for the pair of `RPCSession` instances to communicate over a Conduit channel without any 
coordination because they use long-lived well-known object references, the potential ways you might want to manage 
the object lifecycles related to actual "service" objects within the applications you build with Conduit may differ
greatly depending on your use case. By default service objects are created on-demand for a specific RPCSession 
and are not shared, but you might want to share service objects across multiple sessions (ie multiple connections in the
context of Conduit over Websockets). Control of the lifecycle of service objects can be controlled using custom 
"service factories".

```typescript
session.registerService(MyService, () => myServiceInstance); // where myServiceInstance is not specific to this session
```

Service factories are passed a single argument, the `RPCSession` that is responsible for creating them. This allows you 
easy access to the related session if you need it.

```typescript
session.registerService(MyService, session => new MyService(session));
```

Since service factories are just functions, you could use this to add dependency injection.

# Services without registration, and other low-level customization

If you wish to dynamically create services with arbitrary logic, you can subclass `RPCSession`. 

```typescript
class MySession extends RPCSession {
    @Method()
    override getLocalService(identity: string) {
        // Add arbitrary logic for creating service objects here
        return new MyService();
    }
}
```

This can be used to modify any part of the base APIs, or even add new top-level APIs. It is also how one might use 
well-known references within an application, since the default implementation of `RPCSession` does not provide any 
mechanism for using well-known references (other than the `RPCSession` well known reference).

# Logging

The `RPCSession` class logs certain information which may be important to the operation of your application. By default 
the `console` global is used to do this, but you can override or suppress the logs `RPCSession` does by setting 
`RPCSession#logger`. It is expected that you would tie it into your application's standard logging system.

# Exception Handling

When an exception is thrown by the remote side of a Conduit RPC session it is handled specially. By default the error 
will be logged using `RPCSession#logger` with a severity of `error`, and an `RPCInternalError` will be sent across the 
wire in the thrown error's place. This allows you to inspect your application's logs for diagnostic information when 
an exception occurs while handling RPC calls.

Often it is desirable to intentionally throw a specific error to the caller. You can mark thrown errors specially so 
that they are sent without being replaced by `RPCInternalError`. The simplest way to do this is to call the `raise()` 
function exported by Conduit instead of using the `throw` keyword. That function returns Typescript's `never` type as 
internally it marks the passed error using the `org.webrpc.intentional-error` well-known symbol (see `Symbol.for()`) 
and performs a `throw`. If Conduit detects an exception thrown via `raise()` it will send it directly to the caller 
without replacing it with `RPCInternalError`. 

If you wish to allow all exceptions to flow to the caller unimpeded, you can disable this behavior by setting 
`RPCSession#safeExceptionsMode` to `false`. Note that this may expose internals of your application and filesystem 
structure to untrusted callers.

## Server (callee) Stack Traces

Even if an exception is intentionally returned via `raise()` (or when `safeExceptionsMode` is disabled), the stack 
trace of the exception is removed to avoid exposing implementation details of your application. If you wish to allow 
full stack traces to be received by the client you can set `RPCSession#maskStackTraces` to `false`.

## Client (caller) Stack Traces

Since stack traces of errors which originate from RPC calls can contain information from the remote side, stack traces 
may not be useful if the caller is at fault. To improve this situation, Conduit automatically captures the stack trace 
at the call-site of an RPC method and includes this in any error received by the remote side when rethrowing it on the 
local side. In some cases this may be a better error than you would get if the error were directly thrown from the RPC 
implementation. If you wish to disable injection of client-side stack traces, you can do so by setting 
`RPCSession#addCallerStackTraces` to `false`.

# Discoverability

Conduit has a built-in service discovery mechanism. Call `RPCSession#discoverServices()` to retrieve the services being 
advertised by the remote side. Services are discoverable by default. Each service can be configured to not be 
discoverable by applying the `@Discoverable(false)` decorator.

You can disable introspection for all services by setting `RPCSession#enableDiscovery` to `false`.

# Introspection

Conduit can describe the methods and events available on a particular service via introspection. Call 
`RPCSession#introspectService()` to request information about a specific service. Services are introspectable by 
default. Each service can be configured to not be introspectable by applying the `@Introspectable(false)` decorator.

Discoverability and introspection are mutually independent operations. A service can be configured to be discoverable 
but not introspectable, or introspectable but not discoverable, both or neither.

The type information available in introspection results is basic, roughly equivalent to what Typescript's 
`emitDecoratorMetadata` can provide. In the future more advanced type information will be supported.

You can disable introspection for all services by setting `RPCSession#enableIntrospection` to `false`.

# Wire Format

`@/conduit` encodes messages in JSON, making it ideal for use on the web. Each message has a type, identified by the 
`type` field. There are four types of message:

- `request` -- Request a specific method to be called on a given object, with the given function parameters.
- `response` -- Indicate that a method call has completed
- `ping` -- Check if the connection is still working
- `pong` -- Respond that the connection is indeed still working.

See below for details about these message types.

## `request`
```json
{
    "type": "request",
    "id": "da860252-ce2b-4182-9e8d-3bda07e9f228",
    "receiver": { /* object reference, see below */ },
    "method": "methodName",
    "parameters": [123, "abcdef"],
    "metadata": { /* arbitrary data */ }
}
```

This type of method is sent whenever a remote procedure call is initiated.

- `id` -- A UUIDv4 which is unique to this request. It will be used to identify the response which correlates with this 
  request.
- `receiver` -- The remote object which should receive this message. This will be a Reference, see below for more 
  details on how references work.
- `method` -- The string name of the method which is being called. If the method is not allowed, an error will be 
  returned in the response.
- `parameters` -- An array of the positional parameters that should be passed to the method. Any valid JSON object is 
  allowed, and References are also supported (see below).
- `metadata` -- Arbitary data that Conduit itself will not consider. Useful for passing useful information from the 
  sender to the receiver.

## `response`
```json
{
    "type": "response",
    "id": "da860252-ce2b-4182-9e8d-3bda07e9f228",
    "error": null,
    "value": "return value from the method"
}
```

A successful response will have `error` be null/undefined. A failure response will have `error` be anything other than 
null or undefined. 
- Upon receiving a successful response, Conduit will resolve the promise corresponding to the method call with the 
  given `value`. 
- Upon receiving a failure response, Conduit will reject the promise correspondsing to the method call with the given 
  `error`.

## `ping`
```json
{ "type": "ping" }
```

Can be sent to ensure that message passing is still working over the given channel. Not sent by Conduit by default, see 
the included `DurableSocket` and `DurableSocketChannel` types for more information. When a Conduit session receives 
this message, it always responds with a corresponding `pong` message (see below).

## `pong`
```json
{ "type": "pong" }
```

## References

Conduit supports the ability to refer to remote objects (and local remotable objects) within the request/response 
messages that make up RPC calls.

In fact, this capability is fundamental to how the mechanism works. Every RPC call specifies what object a method is 
being called on as the `receiver` object. The receiver is specified using a Reference.

```json
{ 
    "Rε": "3f7204da-3ace-4edc-8bf3-0c841970c117",
    "S": "L", 
    "Rid": "7a4ba201-fac1-4fda-b26b-270518549e6f" 
}
```

- `Rε`: The ID of the object
- `S`: The "side" that owns this object from the perspective of the sender of the reference object (`L` for "local to 
  sender", `R` for "remote to sender"). Since both sides have local and remote sides and these references are 
  interchanged, the context of where the reference was sent from is important for determining it's meaning. For 
  instance if a message is received which indicates "local side", then this means it is "local to the sender" and 
  "remote to the receiver". If a message is *sent* which indicates remote side, then this means it is "remote to the 
  sender" and "local to the receiver".
- `Rid`: The ID of the reference itself. This is used for properly implementing remote garbage collection (see below).
  Some well-known references do not support multi-referencing, in those cases this field will be omitted or empty (see 
  below).

## Garbage Collection

References to remote objects intelligently handle garbage collection. References on the remote side keep the objects 
they refer to on the local side alive (they won't be garbage collected). When remote references are discarded and get 
garbage collected, references on the server side are automatically discarded to allow objects to be garbage collected.

Every object reference sent within a Conduit message represents a unique reference to a specific object. While each of 
those unique references are outstanding, the sender must not allow the referenced objects to be garbage collected. Each 
one of those references must be finalized by the receiver before the referenced object may be collected. 

Since Conduit only keeps one proxy per remote object, most of the references created to a given object will be 
immediately dismissed. As soon as Conduit resolves the references to an already existing proxy object, it will no 
longer need the new reference. However if no proxy exists yet, the reference will *not* be finalized.

## Well-Known References

If you've read all the above and you now understand that _every_ `request` must specify a valid object reference, you 
might be wondering how an initial `request` would be possible since there are no other calls which might be used to 
tell you how to populate the `receiver` references. You might also wonder how references are finalized for the purposes 
of garbage collection.

All of the base machinery that enables this functionality is provided by the `RPCSession` class itself, _which is 
itself a remotable Conduit object_. There is always exactly 1 `RPCSession` object on each end of an RPC session (makes 
sense), and it is referred to with a special kind of reference called a "well known reference".

Well known references are those where instead of a UUID, the object being referred to has a well-known ID which can be 
predicted by the other side of the conversation. The ID of the `RPCSession` object is always `org.webrpc.session`, so 
it is always possible to refer to this object even before any messages have been sent. Furthermore, the `RPCSession`'s 
lifespan is always at least as long as the lifetime of the channel which it services, which means there is no need to 
manage references for it. Because of these factors, we can create the following reference for the remote's RPCSession 
instance without knowing anything about the object iself, the channel, etc.

```json
{ "Rε": "org.webrpc.session", "S": "R" }
```

APIs like service discovery, introspection, and reference finalization are all implemented as Conduit RPC calls to the 
remote side's `RPCSession` instance.

