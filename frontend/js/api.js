const API_BASE = "http://localhost:4000";
const SESSION_KEY_TOKEN = "shardcore_token";
const SESSION_KEY_ROLE = "shardcore_role";
const SESSION_KEY_USER = "shardcore_user";

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
  const session = loadSession();
  const headers = Object.assign({ "Content-Type": "application/json" }, options.headers || {});
  if (session && session.token) headers["Authorization"] = "Bearer " + session.token;

  const res = await fetch(API_BASE + path, Object.assign({}, options, { headers }));
  let json = {};
  try { json = await res.json(); } catch (e) { /* no body */ }

  if (!res.ok) {
    const err = new Error(json.error || json.message || ("Request failed with status " + res.status));
    err.status = res.status;
    err.data = json;
    throw err;
  }
  return json;
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