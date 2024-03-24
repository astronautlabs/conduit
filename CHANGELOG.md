# 0.6.0 

- Add support for `RPCSession#metadata`. You can now set values on the `metadata` object, and the data you place will 
  be included in each RPC call. You can access metadata sent by the remote side using `session.remote.metadata`.

# 0.5.0

General

- Added `RPCSession#logger` for overriding diagnostic logging
- RPCSession now differentiates between "no receiver specified" and "no receiver with the given ID"

Discovery & Introspection

- Conduit now provides a simple service discovery and introspection mechanism. Use `discoverServices()` to retrieve 
  information about what services are available on the remote side. Use `introspectService()` to learn more information 
  about a service you already know about. Discovery and introspection are enabled for each service by default, 
  and are mutually independent operations; each service can opt out of one or both capabilities by using 
  the `@Discoverable` and `@Introspectable` decorators, respectively. You can use `@Description()` on a service class, 
  method, event, or parameter name to include that description alongside the introspection information. Introspection 
  only includes class features which are exposed via `@Name()`, `@Remotable()` or other exposure mechanisms.
- Introspection currently provides very simple type information, similar to what Typescript provides via 
  `emitDecoratorMetadata`. More advanced type information will be added in the future.

Errors

- Errors are now serialized in a much improved way, including reserializing them on the caller side. This means 
  rejections on RPC calls will have real Error objects (instead of plain `Object` instances) if `RPCSession` knows how 
  to create those errors. Out of the box only the ES standard errors are supported (`AggregateError`, `Error`, 
  `EvalError`, `RangeError`, `ReferenceError`, `SyntaxError`, `TypeError` and `URIError`), as well as the new special 
  error type `RPCInternalError`. If a thrown error is not an instance of an `Error` derived class, the error object is 
  left untouched. If the error is an instance of an `Error` derived class that is unknown, the special `RPCError` class 
  is used as a standin. You can register new error types so that they are automatically serialized on the caller side 
  by using `RPCSession#registerErrorType()`. If the error is a built-in type (ie provided by your Javascript runtime), 
  you should use `RPCSession#registerBuiltinErrorType()`.
- Added `RPCSession#safeExceptionsMode` (default true) which transforms exceptions in RPC responses into 
  `RPCInternalError` and hides exception details unless an exception is specifically tagged as being allowed to be sent 
  to the client. You can mark an exception as being allowed by throwing it using the newly exported `raise` function. 
  Alternatively you can set a property on your error with the well known symbol name `org.webrpc.intentional-error` 
  (see `Symbol.for`) yourself. If an error gets transformed into an `RPCInternalError` a log message with severity 
  `error` is sent via the configured logger (with the default logger the error is printed to the console).
- Added `RPCSession#maskStackTraces` (default true) which removes stack traces on errors which are transmitted to 
  clients.
- Added `RPCSession#addCallerStackTraces` (default true) which causes errors thrown by outbound RPC requests to also 
  have the stack trace of the original method call in addition to the server stack trace (if `maskStackTraces` is 
  disabled).
- You can customize the serialization/deserialization of thrown errors by overriding the `serializeError` and 
  `deserializeError` methods of `RPCSession`

# 0.4.11

- You can now query a `Service.proxy()` for its endpoint, when available, by using `Service.endpointFor(proxy)`.

# 0.4.11

- Allow abstract constructors when calling registerService(), as long as a factory is provided.

# 0.4.10

- Add `createSocket()` method to `DurableSocket` to allow alternative implementations of WebSocket and other 
  pre-validation logic.

# 0.4.9

- Fixes issues which causes duplicate web sockets to be created when trying to reconnect if conditions are 
  correct.

# 0.4.8

- Fixes a bug where remote event listeners are not unsubscribed when state is lost
- More clear errors when a reference has been kept across state loss events
- Introduces `DurableSocket#reconnect()` for causing the socket to reconnect immediately.
