import XHR_HEADERS from '../xhr/headers';
import AUTHORIZATION from '../xhr/authorization';
import * as urlUtils from '../../utils/url';
import { parse as parseUrl, resolve as resolveUrl } from 'url';
import {
    formatSyncCookie,
    generateDeleteSyncCookieStr,
    isOutdatedSyncCookie
} from '../../utils/cookie';

// Skipping transform
function skip () {
    return void 0;
}

function skipIfStateSnapshotIsApplied (src, ctx) {
    return ctx.restoringStorages ? void 0 : src;
}

function isCrossDomainXhrWithoutCredentials (ctx) {
    return ctx.isXhr && !ctx.req.headers[XHR_HEADERS.withCredentials] && ctx.dest.reqOrigin !== ctx.dest.domain;
}

function transformAuthorizationHeader (src, ctx) {
    if (src.includes(AUTHORIZATION.valuePrefix))
        return src.replace(AUTHORIZATION.valuePrefix, '');

    return isCrossDomainXhrWithoutCredentials(ctx) ? void 0 : src;
}

function transformCookieForFetch (src, ctx) {
    const requestCredentials = ctx.req.headers[XHR_HEADERS.fetchRequestCredentials];

    switch (requestCredentials) {
        case 'omit':
            return void 0;
        case 'same-origin':
            return ctx.dest.reqOrigin === ctx.dest.domain ? src : void 0;
        case 'include':
            return src;
        default:
            return void 0;
    }
}

function transformCookie (src, ctx) {
    if (ctx.isXhr)
        return isCrossDomainXhrWithoutCredentials(ctx) ? void 0 : src;
    else if (ctx.isFetch)
        return transformCookieForFetch(src, ctx);

    return src;
}

function generateSyncCookie (ctx, parsedServerCookies) {
    parsedServerCookies = parsedServerCookies.filter(cookie => !cookie.httpOnly);

    let syncWithClientCookies = parsedServerCookies
        .map(cookie => {
            cookie.isServerSync = true;
            cookie.sid          = ctx.session.id;

            return formatSyncCookie(cookie);
        });

    if (ctx.parsedClientSyncCookie) {
        const outdatedSyncCookies = ctx.parsedClientSyncCookie.actual.filter(clientCookie => {
            if (clientCookie.isClientSync && !clientCookie.isWindowSync)
                return true;

            for (const serverCookie of parsedServerCookies) {
                if (isOutdatedSyncCookie(clientCookie, serverCookie))
                    return true;
            }

            return false;
        });

        syncWithClientCookies = ctx.parsedClientSyncCookie.outdated
            .concat(outdatedSyncCookies)
            .map(generateDeleteSyncCookieStr)
            .concat(syncWithClientCookies);
    }

    return syncWithClientCookies;
}

function resolveAndGetProxyUrl (url, ctx) {
    url = urlUtils.prepareUrl(url);

    const { host }    = parseUrl(url);
    let isCrossDomain = false;

    if (!host)
        url = resolveUrl(ctx.dest.url, url);

    if (ctx.isIframe && ctx.dest.referer) {
        const isCrossDomainLocationBeforeRedirect = !urlUtils.sameOriginCheck(ctx.dest.referer, ctx.dest.url);
        const isCrossDomainLocationAfterRedirect  = !urlUtils.sameOriginCheck(ctx.dest.referer, url);

        isCrossDomain = isCrossDomainLocationBeforeRedirect !== isCrossDomainLocationAfterRedirect;
    }

    return ctx.toProxyUrl(url, isCrossDomain, ctx.contentInfo.contentTypeUrlToken);
}

function transformRefreshHeader (src, ctx) {
    return src.replace(/(url=)(.*)$/i, (match, prefix, url) => prefix + resolveAndGetProxyUrl(url, ctx));
}

// Request headers
export const requestTransforms = Object.assign({
    'host':                                (src, ctx) => ctx.dest.host,
    'referer':                             (src, ctx) => ctx.dest.referer || void 0,
    'origin':                              (src, ctx) => ctx.dest.reqOrigin || src,
    'content-length':                      (src, ctx) => ctx.reqBody.length,
    'cookie':                              skip,
    'if-modified-since':                   skipIfStateSnapshotIsApplied,
    'if-none-match':                       skipIfStateSnapshotIsApplied,
    [XHR_HEADERS.requestMarker]:           skip,
    [XHR_HEADERS.withCredentials]:         skip,
    [XHR_HEADERS.origin]:                  skip,
    [XHR_HEADERS.fetchRequestCredentials]: skip
}, AUTHORIZATION.headers.reduce((obj, header) => {
    obj[header] = transformAuthorizationHeader;

    return obj;
}, {}));

export const forcedRequestTransforms = {
    'cookie': (src, ctx) => transformCookie(ctx.session.cookies.getHeader(ctx.dest.url) || void 0, ctx),

    // NOTE: All browsers except Chrome don't send the 'Origin' header in case of the same domain XHR requests.
    // So, if the request is actually cross-domain, we need to force the 'Origin' header to support CORS. (B234325)
    'origin': (src, ctx) => {
        const force = (ctx.isXhr || ctx.isFetch) && !src && ctx.dest.domain !== ctx.dest.reqOrigin;

        return force ? ctx.dest.reqOrigin : src;
    }
};


// Response headers
export const responseTransforms = {
    // NOTE: Disable Content Security Policy (see http://en.wikipedia.org/wiki/Content_Security_Policy).
    'content-security-policy':               skip,
    'content-security-policy-report-only':   skip,
    'x-content-security-policy':             skip,
    'x-content-security-policy-report-only': skip,
    'x-webkit-csp':                          skip,

    // NOTE: Even if we are not able to be authorized, we should prevent showing the native credentials window.
    'www-authenticate': skip,

    // NOTE: We perform CORS checks on our side, so we skip the related headers.
    'access-control-allow-origin': skip,

    // NOTE: Change the transform type if we have an iframe with an image as src,
    // because it was transformed to HTML with the image tag.
    'content-type':   (src, ctx) => ctx.contentInfo.isIframeWithImageSrc ? 'text/html' : src,
    'content-length': (src, ctx) => ctx.contentInfo.requireProcessing ? ctx.destResBody.length : src,

    'location': (src, ctx) => {
        // NOTE: The RFC 1945 standard requires location URLs to be absolute. However, most popular browsers
        // accept relative URLs. We transform relative URLs to absolute to correctly handle this situation.
        if (ctx.contentInfo.isRedirect)
            return resolveAndGetProxyUrl(src, ctx);

        return src;
    },

    'x-frame-options': (src, ctx) => {
        const cspHeader = ctx.destRes.headers['content-security-policy'];

        if (cspHeader && cspHeader.includes('frame-ancestors '))
            return void 0;

        if (!src.includes('ALLOW-FROM'))
            return src;

        src = src.replace('ALLOW-FROM', '').trim();

        const isCrossDomain = ctx.isIframe && !urlUtils.sameOriginCheck(ctx.dest.url, src);
        const proxiedUrl    = ctx.toProxyUrl(src, isCrossDomain, ctx.contentInfo.contentTypeUrlToken);

        return 'ALLOW-FROM ' + proxiedUrl;
    },

    'sourcemap': skip,

    'referrer-policy': () => 'unsafe-url',

    'refresh': (src, ctx) => transformRefreshHeader(src, ctx),

    'link': src => {
        if (/[;\s]rel=\s*prefetch/i.test(src))
            return void 0;

        return src;
    }
};

export const forcedResponseTransforms = {
    'set-cookie': (src, ctx) => {
        let parsedCookies;

        if (src)
            parsedCookies = ctx.session.cookies.setByServer(ctx.dest.url, src);

        if (!ctx.isPage || ctx.isIframe)
            return generateSyncCookie(ctx, parsedCookies || []);

        return [];
    }
};
