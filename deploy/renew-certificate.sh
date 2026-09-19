#!/bin/sh
set -eu
image=$(cat /etc/sofamate/certbot-image)
docker run --rm -v /etc/sofamate/letsencrypt:/etc/letsencrypt -v /srv/sofamate/acme:/var/www/acme "$image" renew --quiet
nginx -t
systemctl reload nginx
