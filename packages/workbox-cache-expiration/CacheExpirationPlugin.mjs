/*
 Copyright 2016 Google Inc. All Rights Reserved.
 Licensed under the Apache License, Version 2.0 (the "License");
 you may not use this file except in compliance with the License.
 You may obtain a copy of the License at
     http://www.apache.org/licenses/LICENSE-2.0
 Unless required by applicable law or agreed to in writing, software
 distributed under the License is distributed on an "AS IS" BASIS,
 WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 See the License for the specific language governing permissions and
 limitations under the License.
*/

import {WorkboxError} from 'workbox-core/_private/WorkboxError.mjs';
import {assert} from 'workbox-core/_private/assert.mjs';
import {CacheExpiration} from './CacheExpiration.mjs';
import './_version.mjs';

/**
 * This plugin can be used in the Workbox API's to regularly enforce a
 * limit on the age and / or the number of cached requests.
 *
 * Whenever a cached request is used or updated, this plugin will look
 * at the used Cache and remove any old or extra requests.
 *
 * When using `maxAgeSeconds`, requests may be used *once* after expiring
 * because the expiration clean up will not have occured until *after* the
 * cached request has been used. If the request has a "Date" header, then
 * a light weight expiration check is performed and the request will not be
 * used immediately.
 *
 * When using `maxEntries`, the last request to be used will be the request
 * that is removed from the Cache.
 *
 * @memberof workbox.expiration
 */
class CacheExpirationPlugin {
  /**
   * @param {Object} config
   * @param {number} [config.maxEntries] The maximum number of entries to cache.
   * Entries used the least will be removed as the maximum is reached.
   * @param {number} [config.maxAgeSeconds] The maximum age of an entry before
   * it's treated as stale and removed.
   */
  constructor(config = {}) {
    if (process.env.NODE_ENV !== 'production') {
      if (!(config.maxEntries || config.maxAgeSeconds)) {
        throw new WorkboxError('max-entries-or-age-required', {
          moduleName: 'workbox-cache-expiration',
          className: 'CacheExpirationPlugin',
          funcName: 'constructor',
        });
      }

      if (config.maxEntries) {
        assert.isType(config.maxEntries, 'number', {
          moduleName: 'workbox-cache-expiration',
          className: 'CacheExpirationPlugin',
          funcName: 'constructor',
          paramName: 'config.maxEntries',
        });
      }

      if (config.maxAgeSeconds) {
        assert.isType(config.maxAgeSeconds, 'number', {
          moduleName: 'workbox-cache-expiration',
          className: 'CacheExpirationPlugin',
          funcName: 'constructor',
          paramName: 'config.maxAgeSeconds',
        });
      }
    }

    this._config = config;
    this._maxAgeSeconds = config.maxAgeSeconds;
    this._cacheExpirations = new Map();
  }

  /**
   * A simple helper method to return a CacheExpiration instance for a given
   * cache name.
   *
   * @param {string} cacheName
   * @return {CacheExpiration}
   *
   * @private
   */
  _getCacheExpiration(cacheName) {
    let cacheExpiration = this._cacheExpirations.get(cacheName);
    if (!cacheExpiration) {
      cacheExpiration = new CacheExpiration(cacheName, this._config);
      this._cacheExpirations.set(cacheName, cacheExpiration);
    }
    return cacheExpiration;
  }

  /**
   * A "lifecycle" callback that will be triggered automatically by the
   * `workbox.runtimeCaching` handlers when a `Response` is about to be returned
   * from a [Cache](https://developer.mozilla.org/en-US/docs/Web/API/Cache) to
   * the handler. It allows the `Response` to be inspected for freshness and
   * prevents it from being used if the `Response`'s `Date` header value is
   * older than the configured `maxAgeSeconds`.
   *
   * @param {Object} input
   * @param {string} input.cacheName Name of the cache the responses belong to.
   * @param {Response} input.cachedResponse The `Response` object that's been
   *        read from a cache and whose freshness should be checked.
   * @return {Response} Either the `cachedResponse`, if it's
   *         fresh, or `null` if the `Response` is older than `maxAgeSeconds`.
   *
   * @private
   */
  cachedResponseWillBeUsed({cacheName, cachedResponse}) {
    let isFresh = this._isResponseDateFresh(cachedResponse);

    // Expire entries to ensure that even if the expiration date has
    // expired, it'll only be used once.
    const cacheExpiration = this._getCacheExpiration(cacheName);
    cacheExpiration.expireEntries();

    return isFresh ? cachedResponse : null;
  }

  /**
   * @param {Response} cachedResponse
   * @return {boolean}
   *
   * @private
   */
  _isResponseDateFresh(cachedResponse) {
    if (!this._maxAgeSeconds) {
      // We aren't expiring by age, so return true, it's fresh
      return true;
    }

    // Check if the 'date' header will suffice a quick expiration check.
    // See https://github.com/GoogleChromeLabs/sw-toolbox/issues/164 for
    // discussion.
    const dateHeaderTimestamp = this._getDateHeaderTimestamp(cachedResponse);
    if (dateHeaderTimestamp === null) {
      // Unable to parse date, so assume it's fresh.
      return true;
    }

    // If we have a valid headerTime, then our response is fresh iff the
    // headerTime plus maxAgeSeconds is greater than the current time.
    const now = Date.now();
    return dateHeaderTimestamp >= now - (this._maxAgeSeconds * 1000);
  }

  /**
   * This method will extract the data header and parse it into a useful
   * value.
   *
   * @param {Response} cachedResponse
   * @return {number}
   *
   * @private
   */
  _getDateHeaderTimestamp(cachedResponse) {
    const dateHeader = cachedResponse.headers.get('date');
    const parsedDate = new Date(dateHeader);
    const headerTime = parsedDate.getTime();

    // If the Date header was invalid for some reason, parsedDate.getTime()
    // will return NaN.
    if (isNaN(headerTime)) {
      return null;
    }

    return headerTime;
  }

  /**
   * A "lifecycle" callback that will be triggered automatically by the
   * `workbox.runtimeCaching` handlers when an entry is added to a cache.
   *
   * @param {Object} input
   * @param {string} input.cacheName Name of the cache the responses belong to.
   * @param {string} input.request The Request for the cached entry.
   *
   * @private
   */
  async cacheDidUpdate({cacheName, request}) {
    if (process.env.NODE_ENV !== 'production') {
      assert.isType(cacheName, 'string', {
        moduleName: 'workbox-cache-expiration',
        className: 'CacheExpirationPlugin',
        funcName: 'cacheDidUpdate',
        paramName: 'cacheName',
      });
      assert.isInstance(request, Request, {
        moduleName: 'workbox-cache-expiration',
        className: 'CacheExpirationPlugin',
        funcName: 'cacheDidUpdate',
        paramName: 'request',
      });
    }

    const cacheExpiration = this._getCacheExpiration(cacheName);
    await cacheExpiration.updateTimestamp(request.url);
    await cacheExpiration.expireEntries();
  }
}

export {CacheExpirationPlugin};
