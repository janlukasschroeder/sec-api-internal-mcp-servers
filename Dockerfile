# the playwright image carries every chromium runtime library, the fonts and
# xvfb. that is what the cloak browser needs, and it saves a long apt list.
FROM mcr.microsoft.com/playwright:v1.62.1-noble

ENV NODE_ENV=production
# the browser factory picks a display per proxy, from :99 upwards
ENV DISPLAY=:99
# a fixed path outside /app, so that a bind mount cannot hide the binary
ENV CLOAKBROWSER_CACHE_DIR=/opt/cloakbrowser

# chromium shows a box glyph for each missing font, and that breaks the canvas
# and screenshot fingerprints. the cloak browser reports a windows platform,
# thus it needs the windows font set as well.
# multiverse holds ttf-mscorefonts-installer. add the component to the sources
# of the image, because the mirror differs per architecture: arm64 uses
# ports.ubuntu.com, amd64 uses archive.ubuntu.com.
RUN sed -i 's/^Components: .*/Components: main restricted universe multiverse/' \
      /etc/apt/sources.list.d/ubuntu.sources \
  && echo "ttf-mscorefonts-installer msttcorefonts/accepted-mscorefonts-eula select true" \
      | debconf-set-selections \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
      fontconfig \
      fonts-liberation \
      ttf-mscorefonts-installer \
  && rm -rf /var/lib/apt/lists/*

# segoe ui: the cloak browser probes for it, and no debian package ships it
RUN curl -fsSL https://codeload.github.com/mrbvrz/segoe-ui-linux/tar.gz/refs/heads/master \
      -o /tmp/segoe.tar.gz \
  && tar -xzf /tmp/segoe.tar.gz -C /tmp \
  && mkdir -p /usr/share/fonts/Microsoft/TrueType/SegoeUI \
  && cp /tmp/segoe-ui-linux-master/font/*.ttf \
      /usr/share/fonts/Microsoft/TrueType/SegoeUI/ \
  && rm -rf /tmp/segoe.tar.gz /tmp/segoe-ui-linux-master \
  && fc-cache -f

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# download the linux chromium of cloakbrowser at build time, so that the first
# request does not wait for it
RUN npx cloakbrowser install

COPY . .

RUN chmod +x docker-entrypoint.sh

EXPOSE 22001

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "modules/server-browser.js"]
