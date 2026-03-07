import { hostname } from './localconf';

export * from './localconf'; // / eslint-disable-line

/**
 * Dynamically get CSRF token to avoid empty token when cookie is not yet set at module load time.
 * Call this function before each request to get the latest value.
 */
export const getCsrfToken = () =>
  document.cookie.replace(/(?:(?:^|.*;\s*)csrftoken\s*=\s*([^;]*).*$)|^.*$/, '$1');

/**
 * Returns request headers with the latest CSRF token for use with fetchWithCreds and similar requests.
 */
export const getHeaders = () => ({
  Accept: 'application/json',
  'Content-Type': 'application/json',
  'x-csrf-token': getCsrfToken(),
});

/**
 * Soon the CSRF cookie will not be readable, as
 * verracode cannot deal with cookies that are not http only.
 *
 * Requests the _status endpoint; the server will set the csrftoken cookie in the response.
 * After getCsrfToken(), the token can be read from document.cookie.
 *
 * @return the csrf token
 */
export async function fetchAndSetCsrfToken() {
  return fetch(`${hostname}_status`, { credentials: 'include' }).then(
    (res) => {
      if (res.status < 200 || res.status > 210) {
        throw new Error('Failed to retrieve CSRF token');
      }
      return res.json();
    },
  ).then(
    (info) => {
      if (!info.csrf) {
        throw new Error('Retrieved empty CSRF token');
      }
      return info.csrf;
    },
  );
}
