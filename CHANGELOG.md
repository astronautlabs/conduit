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
