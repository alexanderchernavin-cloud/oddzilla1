SELECT s.slug, c.id, c.name, c.logo_url
FROM competitors c
JOIN sports s ON s.id = c.sport_id
WHERE c.active = true
  AND c.logo_url LIKE '/team-logos/%'
ORDER BY s.slug, c.name;
