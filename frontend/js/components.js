// components.js — the Shop (customer, modern Amazon/Flipkart-style storefront
// with a cart drawer) and the Admin/System dashboard. Depends on globals
// from api.js (apiFetch, useApi), loaded earlier.

const { useState: useState2, useEffect: useEffect2 } = React;

// Picks an emoji that actually matches the product, by looking for
// keywords in its name — rather than the old approach of cycling through
// a fixed list by id, which had no relationship to what the product was.
// Checked in order, so more specific keywords (e.g. "mouse pad") are
// matched before more general ones (e.g. "mouse"). Falls back to a plain
// box for any product name that doesn't match anything here — this will
// matter for new products an admin adds later through "Add Product".
const EMOJI_KEYWORDS = [
  ["mouse pad", "🎮"],
  ["mouse", "🖱️"],
  ["keyboard", "⌨️"],
  ["hub", "🔌"],
  ["monitor", "🖥️"],
  ["laptop stand", "💻"],
  ["backpack", "🎒"],
  ["webcam", "📷"],
  ["camera", "📷"],
  ["headphone", "🎧"],
  ["earbud", "🎵"],
  ["speaker", "🔊"],
  ["ssd", "💾"],
  ["drive", "💾"],
  ["smartwatch", "⌚"],
  ["watch", "⌚"],
  ["power bank", "🔋"],
  ["microphone", "🎙️"],
  ["chair", "🪑"],
  ["charging pad", "⚡"],
  ["charger", "⚡"],
  ["hdmi", "📺"],
  ["cable", "🔗"],
  ["tablet", "🎨"],
  ["lamp", "💡"],
  ["light", "💡"],
  ["projector", "📽️"],
  ["plug", "🔌"],
  ["phone", "📱"],
];

function emojiFor(name) {
  const lower = (name || "").toLowerCase();
  for (const [keyword, emoji] of EMOJI_KEYWORDS) {
    if (lower.includes(keyword)) return emoji;
  }
  return "📦"; // generic fallback for anything unrecognized
}

// A cosmetic "original price" used only to show a strikethrough/savings
// line, computed deterministically from the real price (no fabricated
// external data — just a consistent 12% markup shown as crossed out,
// a common real-world storefront pattern). This does not affect what is
// actually charged; the real price (product.price) is what's sent to the
// API and what the Coordinator uses for its 2PC transaction.
function fakeMrp(price) { return (Number(price) * 1.12).toFixed(2); }

// ============== SHOP: header, product grid, cart drawer ==============

function Stepper({ value, min, max, onChange }) {
  return (
    <div className="stepper">
      <button type="button" onClick={() => onChange(Math.max(min, value - 1))} disabled={value <= min}>−</button>
      <span>{value}</span>
      <button type="button" onClick={() => onChange(Math.min(max, value + 1))} disabled={value >= max}>+</button>
    </div>
  );
}

function ShopProductCard({ product, cartQty, onAddToCart }) {
  // "remaining" accounts for what the user has already put in their cart,
  // not just the raw stock number — this is what stops someone clicking
  // "Add to Cart" repeatedly and silently exceeding real availability.
  // The authoritative check still happens server-side, inside the 2PC
  // transaction's `SELECT ... FOR UPDATE` at checkout — this is purely a
  // UI-level courtesy so the cart reflects reality before the user even
  // gets to that point.
  const remaining = Math.max(0, product.stock - cartQty);
  const [qty, setQty] = useState2(remaining > 0 ? 1 : 0);

  useEffect2(() => {
    if (qty > remaining) setQty(remaining > 0 ? 1 : 0);
    if (qty === 0 && remaining > 0) setQty(1);
  }, [remaining]);

  const fullyInCart = product.stock > 0 && remaining === 0;
  const outOfStock = product.stock <= 0;
  const stockClass = outOfStock ? "out" : (product.stock <= 3 ? "low" : "ok");
  const stockLabel = outOfStock ? "Out of stock" : (product.stock <= 3 ? `Only ${product.stock} left!` : "In stock");

  return (
    <div className="shop-card">
      <div className="thumb">{emojiFor(product.name)}</div>
      <p className="name">{product.name}</p>
      <div className="price-row">
        <span className="price">₹{Number(product.price).toFixed(2)}</span>
        <span className="mrp">₹{fakeMrp(product.price)}</span>
      </div>
      <div className="save">12% off</div>
      <div className={"stock-line " + stockClass}>{stockLabel}</div>
      <div className="cod-badge">💵 Cash on Delivery available</div>
      {!outOfStock && !fullyInCart && <Stepper value={qty} min={1} max={remaining} onChange={setQty} />}
      {fullyInCart && <p style={{fontSize: "0.75rem", color: "var(--s-muted)", marginBottom: 8}}>All {product.stock} in your cart</p>}
      <button className="shop-add-btn" disabled={outOfStock || fullyInCart} onClick={() => onAddToCart(product, qty, remaining)}>
        {outOfStock ? "OUT OF STOCK" : (fullyInCart ? "MAX IN CART" : "ADD TO CART")}
      </button>
    </div>
  );
}

function CartDrawer({ cart, onClose, onRemove, onCheckoutDone }) {
  const [step, setStep] = useState2("review"); // "review" | "address"
  const [address, setAddress] = useState2("");
  const [city, setCity] = useState2("");
  const [pincode, setPincode] = useState2("");
  const [phone, setPhone] = useState2("");
  const [placing, setPlacing] = useState2(false);
  const [results, setResults] = useState2(null);

  const total = cart.reduce((sum, item) => sum + Number(item.price) * item.quantity, 0);

  const placeOrder = async (e) => {
    e.preventDefault();
    setPlacing(true);
    setResults(null);
    const fullAddress = `${address}, ${city} - ${pincode} (Phone: ${phone})`;
    const outcomes = [];

    // Each cart line is placed as its own real, independent 2PC transaction
    // across the Orders and Products nodes. A multi-item checkout therefore
    // runs several real distributed transactions in sequence, each able to
    // succeed or abort on its own (e.g. if stock ran out for just one item
    // between adding it to the cart and checking out).
    for (const item of cart) {
      try {
        await apiFetch("/orders", {
          method: "POST",
          body: JSON.stringify({ product_id: item.id, quantity: item.quantity, delivery_address: fullAddress }),
        });
        outcomes.push({ name: item.name, ok: true, message: "Confirmed" });
      } catch (err) {
        outcomes.push({ name: item.name, ok: false, message: err.message });
      }
    }
    setResults(outcomes);
    setPlacing(false);
    onCheckoutDone(outcomes);
  };

  return (
    <>
      <div className="cart-overlay" onClick={onClose}></div>
      <div className="cart-drawer">
        <div className="cart-drawer-header">
          <span>🛒 Your Cart ({cart.length})</span>
          <span className="cart-drawer-close" onClick={onClose}>×</span>
        </div>
        <div className="cart-drawer-body">
          {cart.length === 0 && !results && <div className="cart-empty">Your cart is empty.<br/>Add something from the shop!</div>}

          {cart.length > 0 && step === "review" && cart.map(item => (
            <div className="cart-line" key={item.id}>
              <span className="cl-name">{item.name} × {item.quantity}</span>
              <span className="cl-price">₹{(Number(item.price) * item.quantity).toFixed(2)}</span>
              <span className="cl-remove" onClick={() => onRemove(item.id)}>Remove</span>
            </div>
          ))}

          {step === "address" && (
            <form className="shop-address-form" onSubmit={placeOrder}>
              <label>Address line</label>
              <input value={address} onChange={e => setAddress(e.target.value)} required />
              <label>City</label>
              <input value={city} onChange={e => setCity(e.target.value)} required />
              <label>Pincode</label>
              <input value={pincode} onChange={e => setPincode(e.target.value)} required />
              <label>Phone</label>
              <input value={phone} onChange={e => setPhone(e.target.value)} required />
              <button className="checkout-btn" type="submit" disabled={placing}>
                {placing ? "Placing order..." : `Confirm Order (COD) — ₹${total.toFixed(2)}`}
              </button>
            </form>
          )}

          {results && (
            <div style={{marginTop: 12}}>
              {results.map((r, i) => (
                <div key={i} className={"result-msg " + (r.ok ? "success" : "error")}>
                  {r.ok ? "✅ " : "❌ "}{r.name}: {r.message}
                </div>
              ))}
              <p className="refresh-note">Payment is collected in cash on delivery. Each item was confirmed as its own transaction — one item failing doesn't affect the others.</p>
            </div>
          )}
        </div>

        {cart.length > 0 && step === "review" && !results && (
          <div className="cart-drawer-footer">
            <div className="cart-total-row"><span>Total</span><span>₹{total.toFixed(2)}</span></div>
            <button className="checkout-btn" onClick={() => setStep("address")}>Proceed to Checkout</button>
          </div>
        )}
      </div>
    </>
  );
}

function ShopHeader({ userName, cartCount, onCartClick, onOrdersClick, onLogout, search, onSearchChange }) {
  return (
    <div className="shop-topbar">
      <div className="shop-topbar-inner">
        <div className="shop-logo">ShardCore<span>distributed. fault-tolerant.</span></div>
        <div className="shop-search">
          <input placeholder="Search products..." value={search} onChange={e => onSearchChange(e.target.value)} />
        </div>
        <div className="shop-user-area">
          <span className="greet">Hi, {userName}</span>
          <span className="shop-logout" onClick={onLogout}>Logout</span>
          <div className="shop-cart-btn" onClick={onOrdersClick}>📦 My Orders</div>
          <div className="shop-cart-btn" onClick={onCartClick}>
            🛒 Cart
            {cartCount > 0 && <span className="shop-cart-badge">{cartCount}</span>}
          </div>
        </div>
      </div>
      <div className="shop-promo">💵 Cash on Delivery on every order · Free returns within 7 days</div>
    </div>
  );
}

const ORDER_STATUS_LABELS = {
  pending: "Order Placed",
  shipped: "Shipped",
  delivered: "Delivered",
  cancelled: "Cancelled",
};

function OrderHistoryDrawer({ onClose, products }) {
  const { data, error } = useApi("/orders", 5000);
  const productNameFor = (id) => {
    const p = (products || []).find(p => p.id === id);
    return p ? p.name : `Product #${id}`;
  };

  return (
    <>
      <div className="cart-overlay" onClick={onClose}></div>
      <div className="cart-drawer">
        <div className="cart-drawer-header">
          <span>📦 Your Orders</span>
          <span className="cart-drawer-close" onClick={onClose}>×</span>
        </div>
        <div className="cart-drawer-body">
          {error && <div className="result-msg error">{error}</div>}
          {!data && !error && <p style={{color: "var(--s-muted)"}}>Loading your orders...</p>}
          {data && data.rows && data.rows.length === 0 && (
            <div className="cart-empty">You haven't placed any orders yet.</div>
          )}
          {data && data.rows && data.rows.slice().reverse().map(o => (
            <div key={o.id} className="order-history-item">
              <div className="order-history-top">
                <span className="order-history-name">{productNameFor(o.product_id)}</span>
                <span className={"order-status-badge status-" + o.status}>{ORDER_STATUS_LABELS[o.status] || o.status}</span>
              </div>
              <div className="order-history-meta">Qty: {o.quantity} · Order #{o.id}</div>
              {o.delivery_address && <div className="order-history-meta">📍 {o.delivery_address}</div>}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function ShopView({ userName, onLogout }) {
  const { data: productsData, refetch: refetchProducts } = useApi("/products", 5000);
  const [cart, setCart] = useState2([]);
  const [cartOpen, setCartOpen] = useState2(false);
  const [ordersOpen, setOrdersOpen] = useState2(false);
  const [toast, setToast] = useState2(null);
  const [search, setSearch] = useState2("");

  const addToCart = (product, qty, remaining) => {
    // Defense in depth: even though the card's Stepper already limits qty
    // to `remaining`, we clamp again here in case of a stale render (e.g.
    // stock changed via the 5s poll between render and click).
    const safeQty = Math.max(0, Math.min(qty, remaining));
    if (safeQty <= 0) return;
    setCart(prev => {
      const existing = prev.find(i => i.id === product.id);
      if (existing) return prev.map(i => i.id === product.id ? { ...i, quantity: i.quantity + safeQty } : i);
      return [...prev, { id: product.id, name: product.name, price: product.price, quantity: safeQty }];
    });
    setToast(`Added "${product.name}" to cart`);
    setTimeout(() => setToast(null), 1800);
  };

  const cartQtyFor = (productId) => {
    const item = cart.find(i => i.id === productId);
    return item ? item.quantity : 0;
  };

  const removeFromCart = (productId) => setCart(prev => prev.filter(i => i.id !== productId));

  const handleCheckoutDone = (outcomes) => {
    setCart(prev => prev.filter((item, idx) => !(outcomes[idx] && outcomes[idx].ok)));
    refetchProducts();
  };

  const allProducts = (productsData && productsData.rows) || [];
  const filtered = search.trim()
    ? allProducts.filter(p => p.name.toLowerCase().includes(search.trim().toLowerCase()))
    : allProducts;

  return (
    <div className="shop-theme">
      <ShopHeader
        userName={userName}
        cartCount={cart.reduce((n, i) => n + i.quantity, 0)}
        onCartClick={() => setCartOpen(true)}
        onOrdersClick={() => setOrdersOpen(true)}
        onLogout={onLogout}
        search={search}
        onSearchChange={setSearch}
      />
      <div className="shop-inner">
        <h2 className="shop-section-title">{search ? `Results for "${search}"` : "All Products"}</h2>
        {!productsData && <p style={{color: "var(--s-muted)"}}>Loading products...</p>}
        {productsData && filtered.length === 0 && <p style={{color: "var(--s-muted)"}}>No products match your search.</p>}
        <div className="shop-product-grid">
          {filtered.map(p => <ShopProductCard key={p.id} product={p} cartQty={cartQtyFor(p.id)} onAddToCart={addToCart} />)}
        </div>
      </div>

      {cartOpen && (
        <CartDrawer
          cart={cart}
          onClose={() => setCartOpen(false)}
          onRemove={removeFromCart}
          onCheckoutDone={handleCheckoutDone}
        />
      )}
      {ordersOpen && (
        <OrderHistoryDrawer onClose={() => setOrdersOpen(false)} products={allProducts} />
      )}
      {toast && <div className="shop-toast">{toast}</div>}
    </div>
  );
}

// ============== ADMIN / SYSTEM ==============

function ClusterHealth() {
  const { data, error } = useApi("/health", 3000);
  if (error) return <div className="panel full-width"><h2>🩺 Cluster Health</h2><div className="result-msg error">Could not reach API: {error}</div></div>;
  if (!data) return <div className="panel full-width"><h2>🩺 Cluster Health</h2><p>Loading...</p></div>;
  return (
    <div className="panel full-width">
      <h2>🩺 Cluster Health <span style={{fontSize: "0.75rem", color: "var(--muted)", fontWeight: 400}}>(auto-refreshing every 3s)</span></h2>
      {Object.entries(data.nodes).map(([domain, status]) => (
        <div className="node-row" key={domain}>
          <span style={{textTransform: "capitalize"}}>{domain} node</span>
          <span className={"badge " + (status === "UP" ? "up" : "down")}>{status}</span>
        </div>
      ))}
      <div className="cluster-summary">
        {data.reachable} nodes reachable · quorum {data.quorum} ·{" "}
        <strong style={{color: data.cluster_available ? "var(--up)" : "var(--down)"}}>{data.cluster_available ? "AVAILABLE" : "UNAVAILABLE"}</strong>
      </div>
    </div>
  );
}

function DataTable({ title, icon, path, columns }) {
  const { data, error, refetch } = useApi(path, null);
  return (
    <div className="panel">
      <h2>{icon} {title}</h2>
      {error && <div className="result-msg error">{error}</div>}
      {data && (
        <>
          {data.source && <div style={{marginBottom: 8}}><span className={"source-tag " + data.source}>served from {data.source} ({data.node})</span></div>}
          <table>
            <thead><tr>{columns.map(c => <th key={c.key}>{c.label}</th>)}</tr></thead>
            <tbody>{data.rows && data.rows.map(row => <tr key={row.id}>{columns.map(c => <td key={c.key}>{String(row[c.key] ?? "")}</td>)}</tr>)}</tbody>
          </table>
          {(!data.rows || data.rows.length === 0) && <p style={{color: "var(--muted)", fontSize: "0.85rem"}}>No rows yet.</p>}
        </>
      )}
      <button style={{marginTop: 10}} onClick={refetch}>Refresh</button>
    </div>
  );
}

function ProductManager({ refreshKey, bump }) {
  const { data, refetch } = useApi("/products", null);
  const [editingId, setEditingId] = useState2(null);
  const [editName, setEditName] = useState2("");
  const [editPrice, setEditPrice] = useState2("");
  const [editStock, setEditStock] = useState2("");
  const [message, setMessage] = useState2(null);

  const startEdit = (p) => {
    setEditingId(p.id);
    setEditName(p.name);
    setEditPrice(p.price);
    setEditStock(p.stock);
    setMessage(null);
  };

  const saveEdit = async (id) => {
    try {
      await apiFetch(`/products/${id}`, {
        method: "PUT",
        body: JSON.stringify({ name: editName, price: Number(editPrice), stock: Number(editStock) }),
      });
      setEditingId(null);
      refetch();
      bump();
      setMessage({ ok: true, text: "Product updated." });
    } catch (err) {
      setMessage({ ok: false, text: err.message });
    }
  };

  const deleteProduct = async (id, name) => {
    if (!window.confirm(`Delete "${name}"? This cannot be undone.`)) return;
    try {
      await apiFetch(`/products/${id}`, { method: "DELETE" });
      refetch();
      bump();
      setMessage({ ok: true, text: "Product deleted." });
    } catch (err) {
      setMessage({ ok: false, text: err.message });
    }
  };

  return (
    <div className="panel full-width">
      <h2>📦 Manage Products</h2>
      {message && <div className={"result-msg " + (message.ok ? "success" : "error")}>{message.text}</div>}
      {data && data.rows && (
        <table>
          <thead><tr><th>ID</th><th>Name</th><th>Price</th><th>Stock</th><th></th></tr></thead>
          <tbody>
            {data.rows.map(p => (
              <tr key={p.id}>
                {editingId === p.id ? (
                  <>
                    <td>{p.id}</td>
                    <td><input value={editName} onChange={e => setEditName(e.target.value)} /></td>
                    <td><input type="number" step="0.01" value={editPrice} onChange={e => setEditPrice(e.target.value)} style={{width: 80}} /></td>
                    <td><input type="number" value={editStock} onChange={e => setEditStock(e.target.value)} style={{width: 60}} /></td>
                    <td>
                      <button onClick={() => saveEdit(p.id)} style={{marginRight: 6}}>Save</button>
                      <button className="secondary" onClick={() => setEditingId(null)}>Cancel</button>
                    </td>
                  </>
                ) : (
                  <>
                    <td>{p.id}</td>
                    <td>{p.name}</td>
                    <td>{p.price}</td>
                    <td>{p.stock}</td>
                    <td>
                      <button className="secondary" onClick={() => startEdit(p)} style={{marginRight: 6}}>Edit</button>
                      <button className="secondary" onClick={() => deleteProduct(p.id, p.name)} style={{color: "var(--down)"}}>Delete</button>
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function AddProductForm({ onAdded }) {
  const [name, setName] = useState2("");
  const [price, setPrice] = useState2("");
  const [stock, setStock] = useState2("");
  const [result, setResult] = useState2(null);
  const submit = (e) => {
    e.preventDefault();
    apiFetch("/products", { method: "POST", body: JSON.stringify({ name, price: Number(price), stock: Number(stock) }) })
      .then(json => { setResult({ ok: true, message: `Created product #${json.id}` }); setName(""); setPrice(""); setStock(""); onAdded && onAdded(); })
      .catch(err => setResult({ ok: false, message: err.message }));
  };
  return (
    <div className="panel">
      <h2>➕ Add New Product</h2>
      <form onSubmit={submit}>
        <input placeholder="Name" value={name} onChange={e => setName(e.target.value)} required />
        <input placeholder="Price" type="number" step="0.01" value={price} onChange={e => setPrice(e.target.value)} required />
        <input placeholder="Stock" type="number" value={stock} onChange={e => setStock(e.target.value)} required />
        <button type="submit">Add Product</button>
      </form>
      {result && <div className={"result-msg " + (result.ok ? "success" : "error")}>{result.message}</div>}
    </div>
  );
}

function StatCard({ label, value, tone }) {
  return (
    <div className="panel" style={{textAlign: "center"}}>
      <div style={{fontSize: "0.75rem", color: "var(--muted)", marginBottom: 6}}>{label}</div>
      <div style={{fontSize: "1.6rem", fontWeight: 800, color: tone || "var(--text)"}}>{value}</div>
    </div>
  );
}

function StatsPanel({ refreshKey }) {
  const { data, error } = useApi("/admin/stats", 10000);
  if (error) return <div className="panel full-width"><div className="result-msg error">Could not load stats: {error}</div></div>;
  if (!data) return <div className="panel full-width"><p style={{color: "var(--muted)"}}>Loading stats...</p></div>;

  return (
    <div className="full-width">
      <h2 style={{marginBottom: 12}}>📊 Overview</h2>
      <div className="grid" style={{marginBottom: 0}}>
        <StatCard label="Total Order Value (COD)" value={"₹" + data.totalOrderValue} tone="var(--up)" />
        <StatCard label="Orders" value={data.orderCount} />
        <StatCard label="Users" value={data.userCount} />
        <StatCard label="Products" value={data.productCount} />
        <StatCard label="Low Stock (≤3)" value={data.lowStockCount} tone={data.lowStockCount > 0 ? "#f59e0b" : "var(--text)"} />
        <StatCard label="Out of Stock" value={data.outOfStockCount} tone={data.outOfStockCount > 0 ? "var(--down)" : "var(--text)"} />
      </div>
      <p className="refresh-note" style={{marginTop: 4}}>
        Pending: {data.statusCounts.pending} · Shipped: {data.statusCounts.shipped} · Delivered: {data.statusCounts.delivered} · Cancelled: {data.statusCounts.cancelled}
      </p>
      <p className="refresh-note">Total order value is computed by joining Orders (node3) with Products (node2) prices — no single node has both.</p>
    </div>
  );
}

const ORDER_STATUSES = ["pending", "shipped", "delivered", "cancelled"];

function OrderManager({ bump }) {
  const { data, refetch } = useApi("/orders", null);
  const [message, setMessage] = useState2(null);

  const updateStatus = async (id, status) => {
    try {
      await apiFetch(`/orders/${id}`, { method: "PATCH", body: JSON.stringify({ status }) });
      refetch();
      bump();
      setMessage({ ok: true, text: `Order #${id} marked ${status}.` });
    } catch (err) {
      setMessage({ ok: false, text: err.message });
    }
  };

  return (
    <div className="panel full-width">
      <h2>🧾 Manage Orders</h2>
      {message && <div className={"result-msg " + (message.ok ? "success" : "error")}>{message.text}</div>}
      {data && data.source && <div style={{marginBottom: 8}}><span className={"source-tag " + data.source}>served from {data.source} ({data.node})</span></div>}
      {data && data.rows && (
        <table>
          <thead><tr><th>ID</th><th>User</th><th>Product</th><th>Qty</th><th>Delivery Address</th><th>Status</th></tr></thead>
          <tbody>
            {data.rows.map(o => (
              <tr key={o.id}>
                <td>{o.id}</td>
                <td>{o.user_id}</td>
                <td>{o.product_id}</td>
                <td>{o.quantity}</td>
                <td style={{maxWidth: 220, fontSize: "0.78rem", color: "var(--muted)"}}>{o.delivery_address || "—"}</td>
                <td>
                  <select value={o.status} onChange={e => updateStatus(o.id, e.target.value)}>
                    {ORDER_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {(!data || !data.rows || data.rows.length === 0) && <p style={{color: "var(--muted)", fontSize: "0.85rem"}}>No orders yet.</p>}
    </div>
  );
}

function UserManager({ bump }) {
  const { data, refetch } = useApi("/users", null);
  const [message, setMessage] = useState2(null);

  const deleteUser = async (id, name) => {
    if (!window.confirm(`Delete user "${name}"? This cannot be undone.`)) return;
    try {
      await apiFetch(`/users/${id}`, { method: "DELETE" });
      refetch();
      bump();
      setMessage({ ok: true, text: "User deleted." });
    } catch (err) {
      setMessage({ ok: false, text: err.message });
    }
  };

  return (
    <div className="panel">
      <h2>👤 Manage Users</h2>
      {message && <div className={"result-msg " + (message.ok ? "success" : "error")}>{message.text}</div>}
      {data && data.rows && (
        <table>
          <thead><tr><th>ID</th><th>Name</th><th>Email</th><th></th></tr></thead>
          <tbody>
            {data.rows.map(u => (
              <tr key={u.id}>
                <td>{u.id}</td>
                <td>{u.name}</td>
                <td>{u.email}</td>
                <td><button className="secondary" style={{color: "var(--down)"}} onClick={() => deleteUser(u.id, u.name)}>Delete</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {(!data || !data.rows || data.rows.length === 0) && <p style={{color: "var(--muted)", fontSize: "0.85rem"}}>No users yet.</p>}
    </div>
  );
}

function AdminView() {
  const [refreshKey, setRefreshKey] = useState2(0);
  const [adminTab, setAdminTab] = useState2("overview"); // overview | products | orders | users
  const bump = () => setRefreshKey(k => k + 1);

  const TABS = [
    { id: "overview", label: "📊 Overview" },
    { id: "products", label: "📦 Products" },
    { id: "orders", label: "🧾 Orders" },
    { id: "users", label: "👤 Users" },
  ];

  return (
    <div>
      <div className="tabs" style={{marginBottom: 20}}>
        {TABS.map(t => (
          <div key={t.id} className={"tab " + (adminTab === t.id ? "active" : "")} onClick={() => setAdminTab(t.id)}>
            {t.label}
          </div>
        ))}
      </div>

      {adminTab === "overview" && (
        <div>
          <div className="grid"><StatsPanel key={"stats-" + refreshKey} refreshKey={refreshKey} /></div>
          <div className="grid"><ClusterHealth key={"health-" + refreshKey} /></div>
        </div>
      )}

      {adminTab === "products" && (
        <div>
          <div className="grid"><ProductManager key={"pm-" + refreshKey} refreshKey={refreshKey} bump={bump} /></div>
          <div className="grid"><AddProductForm onAdded={bump} /></div>
        </div>
      )}

      {adminTab === "orders" && (
        <div className="grid"><OrderManager key={"om-" + refreshKey} bump={bump} /></div>
      )}

      {adminTab === "users" && (
        <div className="grid">
          <UserManager key={"um-" + refreshKey} bump={bump} />
        </div>
      )}
    </div>
  );
}
