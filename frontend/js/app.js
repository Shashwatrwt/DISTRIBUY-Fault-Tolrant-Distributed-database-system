const { useState: useState4, useEffect: useEffect4 } = React;

function App() {
  const [session, setSession] = useState4(undefined);

  useEffect4(() => {
    setSession(loadSession());
  }, []);

  const handleAuthenticated = () => setSession(loadSession());

  const handleLogout = () => {
    apiFetch("/auth/logout", { method: "POST" }).catch(() => {});
    clearSession();
    setSession(null);
  };

  if (session === undefined) {
    return <div className="container"><p style={{color: "var(--muted)"}}>Loading...</p></div>;
  }

  if (!session) {
    return <LoginPage onAuthenticated={handleAuthenticated} />;
  }

  if (session.role === "admin") {
    return (
      <div className="container">
        <div className="topbar">
          <div>
            <h1 style={{marginBottom: 0}}>Distribuy</h1>
            <p className="subtitle" style={{marginBottom: 0}}>Admin / System Dashboard</p>
          </div>
          <div style={{display: "flex", alignItems: "center", gap: 14}}>
            <span className="who">Logged in as admin</span>
            <span className="logout-link" onClick={handleLogout}>Log out</span>
          </div>
        </div>
        <AdminView />
      </div>
    );
  }

  return <ShopView userName={session.user ? session.user.name : "there"} onLogout={handleLogout} />;
}
ReactDOM.createRoot(document.getElementById("root")).render(<App />);
