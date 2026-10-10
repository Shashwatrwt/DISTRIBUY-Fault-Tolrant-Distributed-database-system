// auth.js — the entry-point login page: pick a role (Consumer or Admin),
// then either log in or (consumers only) sign up for a new account.

const { useState: useState3 } = React;

function ConsumerLoginForm({ onAuthenticated }) {
  const [email, setEmail] = useState3("");
  const [password, setPassword] = useState3("");
  const [error, setError] = useState3(null);
  const [loading, setLoading] = useState3(false);

  const submit = (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    apiFetch("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) })
      .then(json => { saveSession(json.token, json.role, json.user); onAuthenticated(json.role); })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  };

  return (
    <form onSubmit={submit}>
      <input placeholder="Email" type="email" value={email} onChange={e => setEmail(e.target.value)} required autoFocus />
      <input placeholder="Password" type="password" value={password} onChange={e => setPassword(e.target.value)} required />
      <button type="submit" disabled={loading}>{loading ? "Logging in..." : "Log In"}</button>
      {error && <div className="result-msg error">{error}</div>}
    </form>
  );
}

function ConsumerSignupForm({ onAuthenticated }) {
  const [name, setName] = useState3("");
  const [email, setEmail] = useState3("");
  const [password, setPassword] = useState3("");
  const [error, setError] = useState3(null);
  const [loading, setLoading] = useState3(false);

  const submit = (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    apiFetch("/auth/signup", { method: "POST", body: JSON.stringify({ name, email, password }) })
      .then(json => { saveSession(json.token, json.role, json.user); onAuthenticated(json.role); })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  };

  return (
    <form onSubmit={submit}>
      <input placeholder="Full name" value={name} onChange={e => setName(e.target.value)} required autoFocus />
      <input placeholder="Email" type="email" value={email} onChange={e => setEmail(e.target.value)} required />
      <input placeholder="Password" type="password" value={password} onChange={e => setPassword(e.target.value)} required minLength={4} />
      <button type="submit" disabled={loading}>{loading ? "Creating account..." : "Sign Up"}</button>
      {error && <div className="result-msg error">{error}</div>}
    </form>
  );
}

function AdminLoginForm({ onAuthenticated }) {
  const [username, setUsername] = useState3("");
  const [password, setPassword] = useState3("");
  const [error, setError] = useState3(null);
  const [loading, setLoading] = useState3(false);

  const submit = (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    apiFetch("/auth/admin-login", { method: "POST", body: JSON.stringify({ username, password }) })
      .then(json => { saveSession(json.token, json.role, null); onAuthenticated(json.role); })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  };

  return (
    <form onSubmit={submit}>
      <input placeholder="Admin username" value={username} onChange={e => setUsername(e.target.value)} required autoFocus />
      <input placeholder="Password" type="password" value={password} onChange={e => setPassword(e.target.value)} required />
      <button type="submit" disabled={loading}>{loading ? "Logging in..." : "Log In as Admin"}</button>
      {error && <div className="result-msg error">{error}</div>}
      <p className="refresh-note">Demo credentials: admin / admin123</p>
    </form>
  );
}

function LoginPage({ onAuthenticated }) {
  const [role, setRole] = useState3("consumer"); // "consumer" | "admin"
  const [mode, setMode] = useState3("login"); // "login" | "signup" (consumer only)

  return (
    <div className="login-shell">
      <div className="login-box panel">
        <h1 style={{fontSize: "1.3rem"}}>ShardCore</h1>
        <p className="subtitle">Distributed, fault-tolerant PostgreSQL e-commerce backend</p>

        <div className="role-toggle">
          <div className={role === "consumer" ? "active" : ""} onClick={() => setRole("consumer")}>🛍️ Consumer</div>
          <div className={role === "admin" ? "active" : ""} onClick={() => setRole("admin")}>⚙️ Admin</div>
        </div>

        {role === "consumer" ? (
          <>
            <div className="auth-mode-toggle">
              <span className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>Log In</span>
              <span className={mode === "signup" ? "active" : ""} onClick={() => setMode("signup")}>Sign Up</span>
            </div>
            {mode === "login"
              ? <ConsumerLoginForm onAuthenticated={onAuthenticated} />
              : <ConsumerSignupForm onAuthenticated={onAuthenticated} />}
          </>
        ) : (
          <AdminLoginForm onAuthenticated={onAuthenticated} />
        )}
      </div>
    </div>
  );
}
