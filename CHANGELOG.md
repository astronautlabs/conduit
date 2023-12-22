# 0.4.8

- Fixes a bug where remote event listeners are not unsubscribed when state is lost
- More clear errors when a reference has been kept across state loss events
- Introduces `DurableSocket#reconnect()` for causing the socket to reconnect immediately.
