# Push notification server

Does what it says on the tin. Notificaitons are triggered by a webhook in Directus when a live update is published.

There are two important concepts:

1. Channels: these represnt something that can be subscribed to. It could be a live event, articles published by an author, breaking news alerts, etcetera. A channel is just a string and can represent anything.
2. Devices: a device is a user's browser that they have chosen to receive push messages on. Devices can subscribe to multiple channels. In the web spec, these are "push subscriptions", but we call them devices because otherwise we have to deal with the language that a push subscription can be subscribed to multiple channels. The push subscription's subscriptions? We call them devices instead.
