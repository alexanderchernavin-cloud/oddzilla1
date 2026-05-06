SELECT
  s.slug,
  COUNT(*) AS total,
  COUNT(c.logo_url) FILTER (WHERE c.logo_url LIKE '/team-logos/%') AS local,
  COUNT(c.logo_url) FILTER (WHERE c.logo_url LIKE 'http%') AS hot_linked,
  COUNT(*) FILTER (WHERE c.logo_url IS NULL) AS missing
FROM competitors c
JOIN sports s ON s.id = c.sport_id
WHERE c.active = true
  AND s.slug IN ('cs2','dota2','lol','valorant','ml','kog','r6','sc2','cod','aov','rocketleague','overwatch','crossfire','sc1','w3')
GROUP BY s.slug
ORDER BY missing DESC;
