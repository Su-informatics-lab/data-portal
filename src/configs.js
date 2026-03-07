import { hostname } from './localconf';

export * from './localconf'; // / eslint-disable-line

/**
 * 动态获取 CSRF token，避免 module load 时 cookie 尚未设置导致 token 为空。
 * 每次请求前调用此函数以获取最新值。
 */
export const getCsrfToken = () =>
  document.cookie.replace(/(?:(?:^|.*;\s*)csrftoken\s*=\s*([^;]*).*$)|^.*$/, '$1');

/**
 * 返回带最新 CSRF token 的请求头，供 fetchWithCreds 等请求时使用。
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
 * 请求 _status 端点，服务端会在响应中设置 csrftoken cookie。
 * getCsrfToken() 之后可从 document.cookie 读取。
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
