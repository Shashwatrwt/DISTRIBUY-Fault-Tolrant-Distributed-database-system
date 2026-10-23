const API_BASE = "http://localhost:4000";
const SESSION_KEY_TOKEN = "distribuy_token";
const SESSION_KEY_ROLE = "distribuy_role";
const SESSION_KEY_USER = "distribuy_user";

function saveSession(token, role, user) {
  localStorage.setItem(SESSION_KEY_TOKEN, token);
  localStorage.setItem(SESSION_KEY_ROLE, role);
  if (user) localStorage.setItem(SESSION_KEY_USER, JSON.stringify(user));
  else localStorage.removeItem(SESSION_KEY_USER);
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY_TOKEN);
  localStorage.removeItem(SESSION_KEY_ROLE);
  localStorage.removeItem(SESSION_KEY_USER);
}

function loadSession() {
  const token = localStorage.getItem(SESSION_KEY_TOKEN);
  const role = localStorage.getItem(SESSION_KEY_ROLE);
  const userRaw = localStorage.getItem(SESSION_KEY_USER);
  if (!token || !role) return null;
  return { token, role, user: userRaw ? JSON.parse(userRaw) : null };
}

async function apiFetch(path, options = {}) {
  const { timeoutMs, ...requestOptions } = options;
  const session = loadSession();
  const headers = Object.assign({ "Content-Type": "application/json" }, options.headers || {});
  if (session && session.token) headers["Authorization"] = "Bearer " + session.token;

  const controller = timeoutMs ? new AbortController() : null;
  const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetch(API_BASE + path, Object.assign({}, requestOptions, {
      headers,
      ...(controller ? { signal: controller.signal } : {}),
    }));
    let json = {};
    try { json = await res.json(); } catch (e) {}

    if (!res.ok) {
      const err = new Error(json.error || json.message || ("Request failed with status " + res.status));
      err.status = res.status;
      err.data = json;
      throw err;
    }
    return json;
  } catch (err) {
    if (controller && controller.signal.aborted) {
      throw new Error("The request timed out. Check that the API server is running and try again.");
    }
    throw err;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
function useApi(path, intervalMs) {
  const { useState, useEffect, useCallback } = React;
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const fetchData = useCallback(() => {
    apiFetch(path)
      .then(json => { setData(json); setError(null); })
      .catch(err => setError(err.message));
  }, [path]);

  useEffect(() => {
    fetchData();
    if (intervalMs) {
      const id = setInterval(fetchData, intervalMs);
      return () => clearInterval(id);
    }
  }, [fetchData, intervalMs]);

  return { data, error, refetch: fetchData };
}