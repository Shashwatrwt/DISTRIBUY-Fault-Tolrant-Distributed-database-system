#!/bin/bash
# scripts/seed_products.sh — adds a more realistic product catalog.
# Safe to re-run; it just inserts more rows each time.
sudo -u postgres psql -p 5434 -c "INSERT INTO products (name, price, stock) VALUES
  ('USB-C Hub', 1299.00, 12),
  ('27-inch Monitor', 15999.00, 4),
  ('Laptop Stand', 899.00, 20),
  ('Webcam 1080p', 2199.00, 8),
  ('Noise-Cancelling Headphones', 6499.00, 0),
  ('External SSD 1TB', 4999.00, 10);"
