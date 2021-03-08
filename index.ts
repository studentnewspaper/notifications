if (process.env.VAPID_PUBLIC == null || process.env.VAPID_PRIVATE == null)
  throw new Error(`Missing VAPID environment variables`);
if (process.env.HASURA_SECRET == null)
  throw new Error(`Missing GraphQL authentication`);

import express from "express";
import { gql, GraphQLClient } from "graphql-request";
import { setVapidDetails, sendNotification, WebPushError } from "web-push";
import { validate, Joi } from "express-validation";
import cors from "cors";

setVapidDetails(
  "mailto:digital@studentnewspaper.org",
  process.env.VAPID_PUBLIC,
  process.env.VAPID_PRIVATE
);

const server = express();
server.use(express.json());
server.use(
  cors({ origin: ["http://localhost:3000", "https://studentnewspaper.org"] })
);

const bunkerClient = new GraphQLClient(
  "https://bunker.studentnewspaper.org/graphql"
);
const hasuraClient = new GraphQLClient(
  "https://hasura.studentnewspaper.org/v1/graphql",
  { headers: { "x-hasura-admin-secret": process.env.HASURA_SECRET } }
);

async function doesLiveMeetCriteria(
  id: string
): Promise<
  [
    meetsConditions: boolean,
    eventSlug: string,
    eventTitle: string,
    majorText: string
  ]
> {
  const query = gql`
    query getUpdate($id: ID!) {
      items {
        live_updates(filter: { id: { _eq: $id } }, limit: 1) {
          major_text
          status
          event {
            slug
            title
          }
        }
      }
    }
  `;

  const response = await bunkerClient.request(query, { id });
  if (
    response.items.live_updates == null ||
    response.items.live_updates.length == 0
  )
    throw new Error(`Did not find live update ${id}`);

  const update = response.items.live_updates[0];
  return [
    update.major_text != null &&
      update.major_text.trim().length > 0 &&
      update.status == "published",
    update.event.slug,
    update.event.title,
    update.major_text,
  ];
}

async function hasNotificationBeenSent(id: string) {
  const query = gql`
    query getNotification($id: String!) {
      push_sent_notification_by_pk(thing_id: $id) {
        thing_id
      }
    }
  `;

  const response = await hasuraClient.request(query, { id });
  return response.push_sent_notification_by_pk != null;
}

async function markNotificationHandled(id: string) {
  const query = gql`
    mutation markHandled($id: String!) {
      insert_push_sent_notification_one(object: { thing_id: $id }) {
        thing_id
      }
    }
  `;
  await hasuraClient.request(query, { id });
}

async function* getDevices(
  channel: string
): AsyncGenerator<{ endpoint: string; p256dh: string; auth: string }[]> {
  const query = gql`
    query getDevices($channel: String!, $pageSize: Int!, $offset: Int = 0) {
      push_subscription(
        where: { channel: { _eq: $channel } }
        limit: $pageSize
        offset: $offset
        order_by: { id: asc }
      ) {
        device {
          endpoint
          p256dh
          auth
        }
      }
    }
  `;

  const pageSize = 20;
  let count = 0;
  let hasMore = true;

  while (hasMore) {
    const response = await hasuraClient.request(query, {
      channel,
      pageSize,
      offset: count,
    });
    const subscriptions = response.push_subscription;
    count += subscriptions.length;
    hasMore = subscriptions.length == pageSize;
    yield subscriptions.map((subscription: any) => subscription.device);
  }
}

async function setNotificationSentCount(id: string, count: number) {
  const query = gql`
    mutation setNotificationSentCount($id: String!, $count: Int!) {
      update_push_sent_notification_by_pk(
        pk_columns: { thing_id: $id }
        _set: { subscriptions: $count }
      ) {
        thing_id
      }
    }
  `;
  await hasuraClient.request(query, { id, count });
}

async function deleteDevice(deviceId: string) {
  const query = gql`
    mutation deleteDevice($deviceId: String!) {
      delete_push_subscription(where: { id: { _eq: $deviceId } }) {
        affected_rows
      }
      delete_push_device_by_pk(id: $deviceId) {
        id
      }
    }
  `;

  await hasuraClient.request(query, { deviceId });
}

/**
 *
 * @param channel id of the event source (e.g. live event id) to subscribe to
 * @param device device push subscription details
 * @returns id of the newly created subscription
 */
async function createSubscription(
  channel: string,
  device: { endpoint: string; keys: { auth: string; p256dh: string } }
): Promise<string> {
  const query = gql`
    mutation addSubscription(
      $channel: String!
      $deviceEndpoint: String!
      $deviceAuth: String!
      $deviceDh: String!
    ) {
      insert_push_subscription_one(
        object: {
          channel: $channel
          device: {
            data: {
              endpoint: $deviceEndpoint
              auth: $deviceAuth
              p256dh: $deviceDh
            }
            on_conflict: {
              constraint: device_pkey
              where: { endpoint: { _eq: $deviceEndpoint } }
              update_columns: [auth, p256dh]
            }
          }
        }
      ) {
        id
      }
    }
  `;

  const result = await hasuraClient.request(query, {
    channel,
    deviceEndpoint: device.endpoint,
    deviceAuth: device.keys.auth,
    deviceDh: device.keys.p256dh,
  });
  const id = result.insert_push_subscription_one.id;
  return id;
}

async function deleteSubscription(channel: string, endpoint: string) {
  const query = gql`
    mutation deleteSubscription($channel: String!, $endpoint: String!) {
      delete_push_subscription(
        where: { channel: { _eq: $channel }, device_id: { _eq: $endpoint } }
      ) {
        affected_rows
      }
    }
  `;

  const response = await hasuraClient.request(query, { channel, endpoint });
  return true;
}

server.post("/webhook/live", async (req, res) => {
  res.sendStatus(200);

  const updateId = req.body.item;
  const [
    meetsConditions,
    eventSlug,
    eventTitle,
    majorText,
  ] = await doesLiveMeetCriteria(updateId);
  const isSent = await hasNotificationBeenSent(updateId);
  if (!(meetsConditions && !isSent)) return;

  await markNotificationHandled(updateId);

  let count = 0;
  // For live updates, the channel name is the slug
  for await (const devices of getDevices(eventSlug)) {
    for (const device of devices) {
      try {
        await sendNotification(
          {
            endpoint: device.endpoint,
            keys: { auth: device.auth, p256dh: device.p256dh },
          },
          JSON.stringify({
            type: "live-update",
            eventSlug,
            updateId,
            eventTitle,
            majorText,
          })
        );
        count++;
      } catch (err) {
        if (err instanceof WebPushError) {
          if (err.statusCode == 429) {
            // Too many requests, includes Retry-After after
            const retryAfter = err.headers["Retry-After"];
            console.warn(`Hit max requests, try after ${retryAfter}`);
            let secondsWait = 0;
            if (Number.isInteger(retryAfter)) {
              secondsWait = parseInt(retryAfter);
            } else {
              secondsWait = Math.ceil(
                (new Date(retryAfter).valueOf() - new Date().valueOf()) / 1000
              );
            }
            await new Promise((resolve) => {
              setTimeout(() => {
                resolve(null);
              }, secondsWait * 1000);
            });
          } else if (err.statusCode == 410) {
            // Unsubscribed, delete
            deleteDevice(device.endpoint);
          } else if (err.statusCode == 404) {
            // Try and resubscibe the user? Seems difficult, we might just delete
            deleteDevice(device.endpoint);
          } else {
            console.error(`Error sending notification, code ${err.statusCode}`);
            console.error(err.body);
          }
        }
      }
    }
  }

  await setNotificationSentCount(updateId, count);
});

server.post<
  any,
  any,
  {
    channel: string;
    device: { endpoint: string; keys: { auth: string; p256dh: string } };
  }
>(
  "/subscribe",
  validate({
    body: Joi.object({
      channel: Joi.string().required(),
      device: Joi.object({
        endpoint: Joi.string().uri().required(),
        keys: Joi.object({
          auth: Joi.string().required(),
          p256dh: Joi.string().required(),
        }).required(),
      }).required(),
    }).required(),
  }),
  async (req, res) => {
    const subscriptionId = await createSubscription(
      req.body.channel,
      req.body.device
    );
    res.json({ subscriptionId });
  }
);

server.post<any, any, { channel: string; endpoint: string }>(
  "/unsubscribe",
  validate({
    body: Joi.object({
      channel: Joi.string().required(),
      endpoint: Joi.string().uri().required(),
    }),
  }),
  async (req, res) => {
    res.sendStatus(200);
    deleteSubscription(req.body.channel, req.body.endpoint);
  }
);

const port = process.env.PORT || 8001;
server.listen(port, () => {
  console.log(`Server listening on *:${port}`);
});
