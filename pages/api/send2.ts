import isbot from 'isbot';
import ipaddr from 'ipaddr.js';
import { createToken, ok, send, badRequest, forbidden } from 'next-basics';
import { saveEvent } from 'queries';
import { useCors, useSession } from 'lib/middleware';
import { getJsonBody, getIpAddress } from 'lib/detect';
import { secret } from 'lib/crypto';
import { NextApiRequest, NextApiResponse } from 'next';
import { Resolver } from 'dns/promises';

export interface CollectRequestBody {
  payload: {
    data: { [key: string]: any };
    hostname: string;
    language: string;
    referrer: string;
    screen: string;
    title: string;
    url: string;
    website: string;
    name: string;
    session: {
      id: string;
      websiteId: string;
      hostname: string;
      browser: string;
      os: string;
      device: string;
      screen: string;
      language: string;
      country: string;
      subdivision1: string;
      subdivision2: string;
      city: string;
    };
  };
  type: string;
}

export interface NextApiRequestCollect extends NextApiRequest {
  body: CollectRequestBody;
  session: {
    id: string;
    websiteId: string;
    hostname: string;
    browser: string;
    os: string;
    device: string;
    screen: string;
    language: string;
    country: string;
    subdivision1: string;
    subdivision2: string;
    city: string;
  };
  headers: { [key: string]: any };
}

export default async (req: NextApiRequestCollect, res: NextApiResponse) => {
  await useCors(req, res);

  if (isbot(req.headers['user-agent']) && !process.env.DISABLE_BOT_CHECK) {
    return ok(res);
  }

  const { type, payload } = getJsonBody<CollectRequestBody>(req);

  if (type !== 'event') {
    return badRequest(res, 'Wrong payload type.');
  }

  const { url, referrer, name: eventName, data: eventData, title: pageTitle } = payload;

  // Validate eventData is JSON
  if (eventData && !(typeof eventData === 'object' && !Array.isArray(eventData))) {
    return badRequest(res, 'Invalid event data.');
  }

  const ignoreIps = process.env.IGNORE_IP;
  const ignoreHostnames = process.env.IGNORE_HOSTNAME;

  if (ignoreIps || ignoreHostnames) {
    const ips = [];

    if (ignoreIps) {
      ips.push(...ignoreIps.split(',').map(n => n.trim()));
    }

    if (ignoreHostnames) {
      const resolver = new Resolver();
      const promises = ignoreHostnames
        .split(',')
        .map(n => resolver.resolve4(n.trim()).catch(() => {}));

      await Promise.all(promises).then(resolvedIps => {
        ips.push(...resolvedIps.filter(n => n).flatMap(n => n as string[]));
      });
    }

    const clientIp = getIpAddress(req);

    const blocked = ips.find(ip => {
      if (ip === clientIp) return true;

      // CIDR notation
      if (ip.indexOf('/') > 0) {
        const addr = ipaddr.parse(clientIp);
        const range = ipaddr.parseCIDR(ip);

        if (addr.kind() === range[0].kind() && addr.match(range)) return true;
      }

      return false;
    });

    if (blocked) {
      return forbidden(res);
    }
  }

  await useSession(req, res);

  const session = req.session;

  // eslint-disable-next-line prefer-const
  let [urlPath, urlQuery] = url?.split('?') || [];
  let [referrerPath, referrerQuery] = referrer?.split('?') || [];
  let referrerDomain;

  if (!urlPath) {
    urlPath = '/';
  }

  if (referrerPath?.startsWith('http')) {
    const refUrl = new URL(referrer);
    referrerPath = refUrl.pathname;
    referrerQuery = refUrl.search.substring(1);
    referrerDomain = refUrl.hostname.replace(/www\./, '');
  }

  if (process.env.REMOVE_TRAILING_SLASH) {
    urlPath = urlPath.replace(/.+\/$/, '');
  }
  await saveEvent({
    urlPath,
    urlQuery,
    referrerPath,
    referrerQuery,
    referrerDomain,
    pageTitle,
    eventName,
    eventData,
    ...session,
    sessionId: session.id,
  });

  const token = createToken(session, secret());

  return send(res, token);
};
