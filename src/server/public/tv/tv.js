(() => {
  const $ = (id) => document.getElementById(id),
    screen = $("screen");
  let user,
    activeRoom,
    refreshTimer,
    eventSource,
    rendering = false;
  const sections = [
    ["/", "Overview"],
    ["/instances", "Instances"],
    ["/live", "Live TV"],
    ["/requests", "On Demand"],
    ["/library", "Media Library"],
    ["/connections", "Connections"],
    ["/permissions", "Permissions"],
    ["/ai", "AI Concierge"],
    ["/system", "System & Security"],
  ];
  const n = (tag, text, cls) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (cls) node.className = cls;
    return node;
  };
  const tell = (text, error = false) => {
    $("notice").textContent = text;
    $("notice").className = error ? "error" : "";
  };
  async function api(path, body, method = "POST") {
    const res = await fetch(
      path,
      body === undefined
        ? {}
        : {
            method,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
    );
    const data = await res.json();
    if (!res.ok)
      throw new Error(data.message || data.error || "Request failed");
    return data;
  }
  function button(label, fn, cls = "secondary") {
    const b = n("button", label, cls);
    b.type = "button";
    b.onclick = async () => {
      b.disabled = true;
      try {
        await fn();
      } catch (e) {
        tell(e.message, true);
      } finally {
        b.disabled = false;
      }
    };
    return b;
  }
  function panel(title, parent = screen) {
    const box = n("section", undefined, "panel");
    if (title) box.append(n("h2", title));
    parent.append(box);
    return box;
  }
  function table(headers, rows, parent) {
    const wrap = n("div", undefined, "table-wrap"),
      t = n("table"),
      head = n("thead"),
      tr = n("tr");
    headers.forEach((h) => tr.append(n("th", h)));
    head.append(tr);
    const body = n("tbody");
    rows.forEach((row) => {
      const tr = n("tr");
      row.forEach((value) => {
        const td = n("td");
        td.append(
          value instanceof Node ? value : n("span", String(value ?? "")),
        );
        tr.append(td);
      });
      body.append(tr);
    });
    t.append(head, body);
    wrap.append(t);
    parent.append(wrap);
    if (!rows.length) parent.append(n("p", "Nothing configured yet.", "empty"));
    return body;
  }
  const actions = (buttons) => {
    const box = n("div", undefined, "actions");
    box.append(...buttons);
    return box;
  };
  const badge = (state) => n("span", state, "badge " + state);
  function form(parent, descriptors, submit, label = "Save") {
    const f = n("form"),
      grid = n("div", undefined, "form-grid"),
      inputs = {};
    for (const desc of descriptors) {
      const field = n("div", undefined, "field" + (desc.wide ? " wide" : "")),
        lab = n("label", desc.label);
      const id = "f-" + Math.random().toString(36).slice(2);
      lab.htmlFor = id;
      let input;
      if (desc.options) {
        input = n("select");
        if (desc.multiple) input.multiple = true;
        for (const option of desc.options) {
          const o = n(
            "option",
            typeof option === "string" ? option : option.label,
          );
          o.value = typeof option === "string" ? option : option.value;
          if (desc.multiple && desc.value?.includes(o.value)) o.selected = true;
          input.append(o);
        }
      } else input = n(desc.type === "textarea" ? "textarea" : "input");
      input.id = id;
      input.name = desc.name;
      if (!desc.options && desc.type !== "textarea")
        input.type = desc.type || "text";
      if (desc.type === "checkbox") input.checked = !!desc.value;
      else if (!desc.multiple && (!desc.options || desc.value !== undefined))
        input.value = desc.value ?? "";
      if (desc.required) input.required = true;
      if (desc.min !== undefined) input.min = desc.min;
      if (desc.max !== undefined) input.max = desc.max;
      if (desc.type === "password") input.autocomplete = "new-password";
      input.maxLength = desc.maxLength || 2000;
      inputs[desc.name] = input;
      field.append(lab, input);
      if (desc.help) field.append(n("small", desc.help));
      grid.append(field);
    }
    const save = n("button", label);
    save.type = "submit";
    f.append(grid, save);
    f.addEventListener("input", () => {
      f.dataset.dirty = "true";
    });
    f.addEventListener("change", () => {
      f.dataset.dirty = "true";
    });
    f.onsubmit = async (event) => {
      event.preventDefault();
      save.disabled = true;
      const data = {};
      for (const desc of descriptors) {
        const input = inputs[desc.name];
        data[desc.name] =
          desc.type === "checkbox"
            ? input.checked
            : desc.multiple
              ? [...input.selectedOptions].map((o) => o.value)
              : desc.type === "number"
                ? Number(input.value)
                : input.value;
      }
      try {
        await submit(data);
        f.dataset.dirty = "false";
        for (const desc of descriptors)
          if (desc.type === "password") inputs[desc.name].value = "";
      } catch (e) {
        tell(e.message, true);
      } finally {
        save.disabled = false;
      }
    };
    parent.append(f);
    return inputs;
  }
  function modal(title, fn) {
    const d = n("dialog"),
      head = n("header");
    head.append(
      n("h2", title),
      button("Close", () => d.close()),
    );
    d.append(head);
    document.body.append(d);
    d.onclose = () => d.remove();
    fn(d, () => d.close());
    d.showModal();
  }
  async function confirmAction(message, fn) {
    if (window.confirm(message)) await fn();
  }
  const roomOptions = (rooms) =>
    rooms.map((r) => ({ label: `${r.name} · ${r.mode}`, value: r.id }));
  async function chooseRoom(parent, mode) {
    const rooms = (await api("/api/v1/instances")).filter(
      (r) => !mode || r.mode === mode,
    );
    if (!rooms.length) {
      parent.append(n("p", "Create a playback instance first.", "empty"));
      return;
    }
    if (!rooms.some((r) => r.id === activeRoom)) activeRoom = rooms[0].id;
    const select = n("select");
    select.setAttribute("aria-label", "Target room");
    rooms.forEach((r) => {
      const o = n("option", r.name + " · " + r.state);
      o.value = r.id;
      select.append(o);
    });
    select.value = activeRoom;
    select.onchange = () => {
      activeRoom = select.value;
      void render();
    };
    parent.append(select);
    return rooms.find((r) => r.id === activeRoom);
  }
  async function initialize() {
    const state = await api("/api/v1/bootstrap/status");
    if (!state.initialized) return onboarding();
    try {
      const me = await api("/api/v1/auth/me");
      user = me.user;
      $("logout").hidden = false;
      $("logout").onclick = async () => {
        await api("/api/v1/auth/logout", {});
        location.assign("/login");
      };
      navigation();
      await render();
      eventSource = new EventSource("/api/v1/events");
      eventSource.addEventListener("refresh", () => {
        if (
          !document.querySelector("dialog") &&
          !screen.querySelector(
            'input:focus,textarea:focus,select:focus,form[data-dirty="true"]',
          ) &&
          ["/", "/instances", "/live", "/requests"].includes(location.pathname)
        )
          void render();
      });
    } catch (e) {
      login();
    }
  }
  function navigation() {
    $("nav").replaceChildren(
      ...sections.map(([path, label]) => {
        const a = n("a", label);
        a.href = path;
        a.className = location.pathname === path ? "active" : "";
        if (path !== "/library")
          a.onclick = (event) => {
            event.preventDefault();
            history.pushState({}, "", path);
            navigation();
            void render();
          };
        return a;
      }),
    );
  }
  function onboarding() {
    $("title").textContent = "Your station starts here";
    const box = panel("", screen);
    box.classList.add("setup");
    box.append(
      n("p", "STEP 1 OF 3 · CLAIM YOUR PRIVATE DASHBOARD", "steps"),
      n("h2", "Create the administrator"),
      n(
        "p",
        "Read the one-time pairing code from your local container logs. It expires in 15 minutes. No Discord or media account is needed to finish setup.",
      ),
      n(
        "p",
        "Only broadcast content you are authorized to share. User-account self-bots violate Discord rules and risk suspension; official bot tokens do not support native Go Live.",
        "warning",
      ),
    );
    form(
      box,
      [
        {
          name: "code",
          label: "One-time pairing code",
          type: "password",
          required: true,
        },
        {
          name: "username",
          label: "Administrator username",
          required: true,
          maxLength: 80,
        },
        {
          name: "password",
          label: "Unique password (16+ characters)",
          type: "password",
          required: true,
        },
        {
          name: "rightsAccepted",
          label: "I will broadcast only content I have permission to share",
          type: "checkbox",
          required: true,
        },
      ],
      async (data) => {
        await api("/api/v1/bootstrap/claim", data);
        screen.replaceChildren();
        tell(
          "Administrator created. Add optional connections, then create your first instance.",
        );
        await initialize();
      },
      "Create administrator",
    );
    box.append(
      button("Renew expired pairing code", async () => {
        const result = await api("/api/v1/bootstrap/renew", {});
        tell(result.message);
      }),
    );
  }
  function login() {
    screen.replaceChildren();
    $("title").textContent = "Welcome back";
    const box = panel("Sign in");
    box.classList.add("setup");
    form(
      box,
      [
        { name: "username", label: "Username", required: true },
        {
          name: "password",
          label: "Password",
          type: "password",
          required: true,
        },
      ],
      async (data) => {
        await api("/api/v1/auth/login", data);
        await initialize();
      },
      "Sign in",
    );
  }
  async function render() {
    if (rendering) return;
    rendering = true;
    try {
      screen.replaceChildren();
      $("title").textContent =
        sections.find(([p]) => p === location.pathname)?.[1] || "Overview";
      $("breadcrumb").textContent = "STREAMBOT TV / " + user.username;
      const page = location.pathname;
      if (page === "/instances") await instanceScreen();
      else if (page === "/connections") await connections();
      else if (page === "/live") await live();
      else if (page === "/requests") await requests();
      else if (page === "/permissions") await permissions();
      else if (page === "/ai") await aiScreen();
      else if (page === "/system") await system();
      else await overview();
    } catch (e) {
      tell(e.message, true);
    } finally {
      rendering = false;
    }
  }
  async function overview() {
    const rooms = await api("/api/v1/instances");
    const stats = n("div", undefined, "grid stats");
    for (const [label, value] of [
      ["Instances", rooms.length],
      [
        "Online",
        rooms.filter((r) => ["ready", "streaming"].includes(r.state)).length,
      ],
      ["Streaming", rooms.filter((r) => r.state === "streaming").length],
      [
        "Worker memory",
        Math.round(
          rooms.reduce((n, r) => n + (r.metrics?.rss || 0), 0) / 1048576,
        ) + " MB",
      ],
    ]) {
      const box = panel(label, stats);
      box.append(n("strong", String(value), "number"));
    }
    screen.append(stats);
    const box = panel("Your channels");
    table(
      ["Instance", "Mode", "State", "Now playing"],
      rooms.map((r) => [
        button(r.name, () => {
          activeRoom = r.id;
          history.pushState({}, "", "/instances");
          navigation();
          return render();
        }),
        r.mode,
        badge(r.state),
        r.current
          ? `${r.current.title} · ${Math.floor((r.current.elapsedMs || 0) / 60000)} min elapsed${r.current.durationMs ? " / " + Math.round(r.current.durationMs / 60000) + " min" : ""}`
          : r.error || "Idle",
      ]),
      box,
    );
    if (!rooms.length) {
      box.append(
        n(
          "p",
          "Add your media and Discord connections, then create six live channels and two on-demand rooms—or any number within your resource limits.",
        ),
        button(
          "Add connections",
          () => {
            history.pushState({}, "", "/connections");
            navigation();
            return render();
          },
          "",
        ),
      );
    }
    panel("Transport & broadcast permissions").append(
      n(
        "p",
        "Official Discord applications provide legitimate commands and interactions. Native Go Live is available only through the explicitly experimental user-account transport, which violates Discord policy and can lead to account suspension. Broadcast only authorized content.",
        "warning",
      ),
    );
  }
  async function instanceEditor(existing) {
    const providers = await api("/api/v1/providers");
    let destinations = [];
    for (const app of (await api("/api/v1/applications")).filter(
      (a) => a.connected,
    )) {
      try {
        const guilds = await api(`/api/v1/applications/${app.id}/guilds`);
        for (const guild of guilds)
          for (const channel of guild.channels)
            destinations.push({
              label: guild.name + " / " + channel.name,
              value: guild.id + "/" + channel.id,
            });
      } catch {}
    }
    modal(existing ? "Edit instance" : "Create instance", (box, close) => {
      box.append(
        n(
          "p",
          "Each active worker needs an independent entitled playback account and voice destination. No membership or permission bypass. Official control-only instances cannot broadcast video.",
          "warning",
        ),
      );
      const c = existing || {};
      const e = c.encoder || {};
      form(
        box,
        [
          { name: "name", label: "Name", value: c.name, required: true },
          {
            name: "mode",
            label: "Mode",
            options: ["live", "on-demand"],
            value: c.mode || "on-demand",
          },
          {
            name: "transport",
            label: "Transport",
            options: [
              {
                value: "official-control-only",
                label: "Control only — native video unsupported",
              },
              {
                value: "experimental-selfbot",
                label: "Experimental user account — suspension risk",
              },
            ],
            value: c.transport,
          },
          {
            name: "destination",
            label:
              "Discovered destinations (access must still be tested by playback account)",
            options: [
              { label: "Manual IDs below", value: "" },
              ...destinations,
            ],
          },
          {
            name: "guildId",
            label: "Discord guild ID",
            value: c.guildId,
            required: !destinations.length,
          },
          {
            name: "voiceChannelId",
            label: "Voice channel ID",
            value: c.voiceChannelId,
            required: true,
          },
          {
            name: "prefix",
            label: "Optional legacy command prefix",
            value: c.prefix || "$",
          },
          {
            name: "commandChannelId",
            label: "Legacy command channel ID (blank disables prefix commands)",
            value: c.commandChannelId || "",
          },
          {
            name: "credential",
            label: "Playback account credential (leave empty to retain)",
            type: "password",
          },
          {
            name: "providerIds",
            label: "Allowed media sources (empty = all)",
            options: providers.map((p) => ({ label: p.name, value: p.id })),
            multiple: true,
            value: c.providerIds || [],
          },
          {
            name: "enabled",
            label: "Enabled",
            type: "checkbox",
            value: c.enabled ?? true,
          },
          {
            name: "autostart",
            label: "Autostart after application recovery",
            type: "checkbox",
            value: c.autostart,
          },
          {
            name: "autojoin",
            label: "Join configured voice channel on start",
            type: "checkbox",
            value: c.autojoin,
          },
          {
            name: "riskAccepted",
            label: "I understand the experimental self-bot account risk",
            type: "checkbox",
            value: c.riskAccepted,
          },
          ...["width", "height", "fps", "bitrateKbps", "maxBitrateKbps"].map(
            (key, index) => ({
              name: key,
              label: [
                "Width",
                "Height",
                "FPS",
                "Bitrate (kbps)",
                "Maximum bitrate (kbps)",
              ][index],
              type: "number",
              value: e[key] || [1280, 720, 30, 2000, 2500][index],
            }),
          ),
          {
            name: "videoCodec",
            label: "Video codec",
            options: ["H264", "H265", "VP8"],
            value: e.videoCodec || "H264",
          },
          {
            name: "h26xPreset",
            label: "Encoder preset",
            options: [
              "ultrafast",
              "superfast",
              "veryfast",
              "faster",
              "fast",
              "medium",
              "slow",
              "slower",
              "veryslow",
            ],
            value: e.h26xPreset || "ultrafast",
          },
          {
            name: "hardwareAcceleratedDecoding",
            label: "Hardware decode (requires working host/device support)",
            type: "checkbox",
            value: e.hardwareAcceleratedDecoding,
          },
          {
            name: "maxRetries",
            label: "Worker crash retry budget",
            type: "number",
            value: c.maxRetries ?? 3,
          },
          {
            name: "mediaRetries",
            label: "Retries per failed media item",
            type: "number",
            value: c.mediaRetries ?? 1,
          },
        ],
        async (data) => {
          if (data.destination) {
            [data.guildId, data.voiceChannelId] = data.destination.split("/");
          }
          delete data.destination;
          data.encoder = {};
          for (const key of [
            "width",
            "height",
            "fps",
            "bitrateKbps",
            "maxBitrateKbps",
            "videoCodec",
            "h26xPreset",
            "hardwareAcceleratedDecoding",
          ]) {
            data.encoder[key] = data[key];
            delete data[key];
          }
          if (!data.credential) delete data.credential;
          if (c.id) data.revision = c.revision;
          await api(
            "/api/v1/instances" + (c.id ? "/" + c.id : ""),
            data,
            c.id ? "PATCH" : "POST",
          );
          close();
          tell("Instance saved.");
          await render();
        },
      );
    });
  }
  let roomModeFilter = "all",
    roomStateFilter = "all";
  async function instanceScreen() {
    const rooms = await api("/api/v1/instances");
    const box = panel("Playback instances");
    box.append(
      actions([
        button("Create instance", () => instanceEditor(), ""),
        button("Refresh", render),
      ]),
    );
    const filters = n("div", undefined, "toolbar");
    for (const [label, values, current, update] of [
      [
        "Mode",
        ["all", "live", "on-demand"],
        roomModeFilter,
        (value) => {
          roomModeFilter = value;
        },
      ],
      [
        "State",
        [
          "all",
          "stopped",
          "starting",
          "connecting",
          "ready",
          "streaming",
          "reconnecting",
          "stopping",
          "failed",
          "disabled",
        ],
        roomStateFilter,
        (value) => {
          roomStateFilter = value;
        },
      ],
    ]) {
      const select = n("select");
      select.setAttribute("aria-label", label + " filter");
      for (const value of values) {
        const option = n("option", value);
        option.value = value;
        select.append(option);
      }
      select.value = current;
      select.onchange = () => {
        update(select.value);
        void render();
      };
      filters.append(select);
    }
    box.append(filters);
    table(
      ["Instance / destination", "Mode", "State", "Controls"],
      rooms
        .filter(
          (r) =>
            (roomModeFilter === "all" || r.mode === roomModeFilter) &&
            (roomStateFilter === "all" || r.state === roomStateFilter),
        )
        .map((r) => [
          n("span", `${r.name}\n${r.guildId} / ${r.voiceChannelId}`),
          r.mode,
          n("span", r.error ? `${r.state} · ${r.error}` : r.state),
          actions([
            button("Queue", () => {
              activeRoom = r.id;
              return queueDetail(r);
            }),
            ...["start", "stop", "restart", "connect", "disconnect"].map(
              (action) =>
                button(
                  action === "connect" ? "Join / move VC" : action,
                  async () => {
                    await api(`/api/v1/instances/${r.id}/${action}`, {});
                    tell(
                      action === "connect"
                        ? "Voice connection verified."
                        : `${action} completed`,
                    );
                    await render();
                  },
                ),
            ),
            button("Logs", async () => {
              const rows = await api(`/api/v1/instances/${r.id}/logs`);
              modal("Instance audit / lifecycle", (box) =>
                table(
                  ["Time", "Action", "Outcome"],
                  rows.map((row) => [
                    new Date(row.created_at).toLocaleString(),
                    row.action,
                    row.outcome,
                  ]),
                  box,
                ),
              );
            }),
            button("Edit", () => instanceEditor(r)),
            button(
              "Revoke account",
              () =>
                confirmAction(
                  "Stop this instance and remove its encrypted credential?",
                  async () => {
                    await api(`/api/v1/instances/${r.id}/revoke`, {
                      confirm: true,
                    });
                    await render();
                  },
                ),
              "danger",
            ),
            button("Duplicate", async () => {
              await api(`/api/v1/instances/${r.id}/duplicate`, {});
              await render();
            }),
            button(
              "Delete",
              () =>
                confirmAction(
                  "Delete this instance, its queue and playlists? Reusable media providers and credentials are retained.",
                  async () => {
                    await api(
                      "/api/v1/instances/" + r.id,
                      { confirm: true },
                      "DELETE",
                    );
                    await render();
                  },
                ),
              "danger",
            ),
          ]),
        ]),
      box,
    );
    if (activeRoom && rooms.some((r) => r.id === activeRoom))
      await queueDetail(rooms.find((r) => r.id === activeRoom));
  }
  async function queueDetail(room) {
    $("queue-detail")?.remove();
    const box = panel("Queue · " + room.name);
    box.id = "queue-detail";
    const data = await api(`/api/v1/instances/${room.id}/queue`);
    box.append(
      actions([
        button("Skip", () => api(`/api/v1/instances/${room.id}/skip`, {})),
        button(
          "Clear queue",
          () =>
            confirmAction(
              "Clear pending items and skip the current request?",
              () =>
                api(`/api/v1/instances/${room.id}/queue/clear`, {
                  confirm: true,
                }),
            ),
          "danger",
        ),
      ]),
    );
    const reorder = async (index, delta) => {
      const order = data.items.map((q) => q.id),
        other = index + delta;
      if (other < 0 || other >= order.length) return;
      [order[index], order[other]] = [order[other], order[index]];
      await api(
        `/api/v1/instances/${room.id}/queue/order`,
        { order, revision: data.revision },
        "PATCH",
      );
      await queueDetail(room);
    };
    table(
      ["Title", "State", "Requester", "Order"],
      data.items.map((q, index) => [
        q.source.title,
        q.status,
        q.actor,
        actions([
          button("↑", () => reorder(index, -1)),
          button("↓", () => reorder(index, 1)),
        ]),
      ]),
      box,
    );
    form(
      box,
      [
        { name: "input", label: "URL or YouTube search", required: true },
        { name: "title", label: "Display title", value: "URL / search" },
      ],
      async (selection) => {
        await api(`/api/v1/instances/${room.id}/queue`, { items: [selection] });
        await queueDetail(room);
      },
      "Add source",
    );
    const file = n("input");
    file.type = "file";
    file.setAttribute("aria-label", "Upload local video");
    box.append(
      file,
      button("Upload video", async () => {
        if (!file.files[0]) throw Error("Choose a video first");
        const data = new FormData();
        data.append("file", file.files[0]);
        const response = await fetch("/api/v1/local/upload", {
          method: "POST",
          body: data,
        });
        if (!response.ok) throw Error("Upload failed");
        tell("Local video uploaded");
        await queueDetail(room);
      }),
    );
    const files = await api("/api/v1/local");
    if (files.length)
      form(
        box,
        [{ name: "local", label: "Local video", options: files }],
        async (selection) => {
          await api(`/api/v1/instances/${room.id}/queue`, {
            items: [selection],
          });
          await queueDetail(room);
        },
        "Queue local video",
      );
  }
  async function live() {
    const controls = panel("Continuous channel");
    const room = await chooseRoom(controls, "live");
    if (!room) return;
    const playlist = await api(`/api/v1/instances/${room.id}/playlists`);
    const saved = await api(`/api/v1/instances/${room.id}/saved-playlists`);
    form(
      controls,
      [
        {
          name: "playlistId",
          label: "Saved playlist",
          options: saved.map((p) => ({
            label: p.name + (p.selected ? " · selected" : ""),
            value: p.id,
          })),
          value: playlist.id,
        },
      ],
      async (data) => {
        await api(`/api/v1/instances/${room.id}/playlists/select`, data);
        await render();
      },
      "Select saved playlist (stop instance first)",
    );
    controls.append(
      n(
        "p",
        "Continuous playback follows actual completion. After recovery, the interrupted item restarts from its beginning; frame-accurate resume is not promised.",
      ),
    );
    form(
      controls,
      [
        { name: "name", label: "Playlist name", value: playlist.config.name },
        {
          name: "repeat",
          label: "Repeat",
          options: ["off", "one", "all"],
          value: playlist.config.repeat,
        },
        {
          name: "shuffle",
          label: "Shuffle (stable per cycle)",
          type: "checkbox",
          value: playlist.config.shuffle,
        },
        {
          name: "active",
          label: "Playlist active",
          type: "checkbox",
          value: playlist.config.active,
        },
      ],
      async (data) => {
        await api(
          `/api/v1/instances/${room.id}/playlists`,
          { ...data, revision: playlist.revision },
          "PATCH",
        );
        await render();
      },
    );
    const box = panel("Playlist · " + playlist.entries.length + " entries");
    box.append(
      actions([
        button("Browse media", () => location.assign("/library")),
        button("Duplicate playlist", async () => {
          await api(`/api/v1/instances/${room.id}/playlists/duplicate`, {
            name: playlist.config.name + " copy",
          });
          await render();
        }),
        button("Export references", async () => {
          const data = await api(
            `/api/v1/instances/${room.id}/playlists/export`,
          );
          const a = n("a");
          const url = URL.createObjectURL(
            new Blob([JSON.stringify(data)], { type: "application/json" }),
          );
          a.href = url;
          a.download = "streambot-playlist-references.json";
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
          tell(
            data.excludedPrivateInputs
              ? "Exported provider/local references; private URL inputs were excluded."
              : "Playlist references exported.",
          );
        }),
        button(
          "Clear playlist",
          () =>
            confirmAction(
              "Remove every entry from this playlist?",
              async () => {
                await api(
                  `/api/v1/instances/${room.id}/playlists`,
                  { revision: playlist.revision, clear: true },
                  "PATCH",
                );
                await render();
              },
            ),
          "danger",
        ),
      ]),
    );
    const reorder = async (order) => {
      await api(
        `/api/v1/instances/${room.id}/playlists`,
        { revision: playlist.revision, order },
        "PATCH",
      );
      await render();
    };
    let dragged;
    const body = table(
      ["Position", "Title", "Source", "Edit"],
      playlist.entries.map((entry, index) => [
        String(index + 1),
        entry.source.title,
        entry.source.reference?.providerId ||
          (entry.source.local ? "local" : "URL / search"),
        actions([
          button("↑", () => {
            if (!index) return;
            const order = playlist.entries.map((e) => e.id);
            [order[index - 1], order[index]] = [order[index], order[index - 1]];
            return reorder(order);
          }),
          button("↓", () => {
            if (index === playlist.entries.length - 1) return;
            const order = playlist.entries.map((e) => e.id);
            [order[index + 1], order[index]] = [order[index], order[index + 1]];
            return reorder(order);
          }),
          button("Remove", async () => {
            await api(
              `/api/v1/instances/${room.id}/playlists`,
              { revision: playlist.revision, remove: [entry.id] },
              "PATCH",
            );
            await render();
          }),
        ]),
      ]),
      box,
    );
    [...body.children].forEach((tr, index) => {
      tr.draggable = true;
      tr.classList.add("drag");
      tr.ondragstart = () => {
        dragged = index;
      };
      tr.ondragover = (e) => e.preventDefault();
      tr.ondrop = (e) => {
        e.preventDefault();
        const order = playlist.entries.map((e) => e.id);
        const [id] = order.splice(dragged, 1);
        order.splice(index, 0, id);
        void reorder(order).catch((e) => tell(e.message, true));
      };
    });
    const importFile = n("input");
    importFile.type = "file";
    importFile.accept = ".json";
    importFile.setAttribute("aria-label", "Import playlist references");
    box.append(
      importFile,
      button("Import references", async () => {
        if (!importFile.files[0] || importFile.files[0].size > 2 * 1024 * 1024)
          throw Error("Choose a reference playlist under 2 MiB");
        const data = JSON.parse(await importFile.files[0].text());
        const result = await api(
          `/api/v1/instances/${room.id}/playlists/import`,
          data,
        );
        tell(`${result.count} references imported`);
        await render();
      }),
    );
    form(
      box,
      [
        { name: "input", label: "Add URL or YouTube search", required: true },
        { name: "title", label: "Display title", value: "URL / search" },
      ],
      async (selection) => {
        await api(`/api/v1/instances/${room.id}/playlists`, {
          items: [selection],
        });
        await render();
      },
      "Add to playlist",
    );
  }
  async function connections() {
    const list = await api("/api/v1/providers"),
      box = panel("Jellyfin & Silo");
    box.append(
      n(
        "p",
        "Silo uses its actual Jellyfin compatibility listener and profile login, such as account#profile. Tokens are encrypted and never returned after saving.",
      ),
    );
    box.append(button("Add media source", () => providerEditor(), ""));
    table(
      ["Name", "Kind", "Credential", "Controls"],
      list.map((p) => [
        p.name,
        p.kind,
        p.secret.configured ? "Configured" : "Missing",
        actions([
          button("Test", async () => {
            const result = await api(`/api/v1/providers/${p.id}/test`, {});
            tell(`Connected · version ${result.version}`);
          }),
          button("Edit / replace credential", () => providerEditor(p)),
          button(
            "Revoke",
            () =>
              confirmAction(
                "Stop playback using this provider and revoke its stored credential?",
                async () => {
                  await api(`/api/v1/providers/${p.id}/revoke`, {
                    confirm: true,
                  });
                  await render();
                },
              ),
            "danger",
          ),
          button(
            "Remove",
            () =>
              confirmAction(
                "Remove this source? Referenced playlists must be edited first.",
                async () => {
                  await api(
                    `/api/v1/providers/${p.id}`,
                    { confirm: true },
                    "DELETE",
                  );
                  await render();
                },
              ),
            "danger",
          ),
        ]),
      ]),
      box,
    );
    const applications = await api("/api/v1/applications"),
      apps = panel("Official Discord command applications");
    apps.append(
      n(
        "p",
        "Install your application in the intended guild with bot and applications.commands scopes. These credentials provide commands and role checks; they cannot broadcast native Go Live.",
        "warning",
      ),
    );
    apps.append(
      button("Add command application", () => applicationEditor(), ""),
    );
    table(
      ["Application", "Connection", "Controls"],
      applications.map((a) => [
        a.name,
        a.error || (a.connected ? "Connected" : "Stopped"),
        actions([
          button("Start / register commands", async () => {
            await api(`/api/v1/applications/${a.id}/start`, {});
            await render();
          }),
          button("Stop", async () => {
            await api(`/api/v1/applications/${a.id}/stop`, {});
            await render();
          }),
          button("Edit", () => applicationEditor(a)),
          button(
            "Remove",
            () =>
              confirmAction("Remove this command connection?", async () => {
                await api(`/api/v1/applications/${a.id}/remove`, {
                  confirm: true,
                });
                await render();
              }),
            "danger",
          ),
        ]),
      ]),
      apps,
    );
    for (const application of applications) {
      const link = n(
        "a",
        "Install " + application.name + " in an authorized Discord guild",
      );
      link.href =
        "https://discord.com/oauth2/authorize?client_id=" +
        application.applicationId +
        "&scope=bot%20applications.commands&permissions=3072";
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      apps.append(link, n("br"));
    }
  }
  function providerEditor(p = {}) {
    modal(
      p.id ? "Edit media source" : "Connect a media source",
      (box, close) => {
        form(
          box,
          [
            {
              name: "name",
              label: "Display name",
              value: p.name,
              required: true,
            },
            {
              name: "kind",
              label: "Provider",
              options: ["jellyfin", "silo"],
              value: p.kind,
            },
            {
              name: "baseUrl",
              label: "API / compatibility base URL",
              type: "url",
              value: p.baseUrl,
              required: true,
            },
            {
              name: "userId",
              label: "Jellyfin viewer ID (for API keys)",
              value: p.userId,
            },
            {
              name: "token",
              label: "API / compatibility token (or use login below)",
              type: "password",
            },
            {
              name: "username",
              label: "Login username (Silo account#profile)",
              value: "",
            },
            {
              name: "password",
              label: "Login password / PIN format when supported",
              type: "password",
            },
          ],
          async (data) => {
            const credentials = {};
            for (const key of ["token", "username", "password"]) {
              if (data[key]) credentials[key] = data[key];
              delete data[key];
            }
            if (Object.keys(credentials).length) data.credentials = credentials;
            if (p.id) data.revision = p.revision;
            await api(
              "/api/v1/providers" + (p.id ? "/" + p.id : ""),
              data,
              p.id ? "PATCH" : "POST",
            );
            close();
            tell("Connection saved. Test access before playback.");
            await render();
          },
        );
      },
    );
  }
  function applicationEditor(a = {}) {
    modal("Discord command connection", (box, close) => {
      form(
        box,
        [
          { name: "name", label: "Name", value: a.name, required: true },
          {
            name: "applicationId",
            label: "Discord application ID",
            value: a.applicationId,
            required: true,
          },
          {
            name: "guildIds",
            label: "Installed guild IDs (comma separated)",
            value: a.guildIds?.join(", "),
            required: true,
          },
          {
            name: "credential",
            label: "Application bot token (blank retains existing)",
            type: "password",
          },
        ],
        async (data) => {
          data.guildIds = data.guildIds
            .split(",")
            .map((v) => v.trim())
            .filter(Boolean);
          if (!data.credential) delete data.credential;
          await api(
            "/api/v1/applications" + (a.id ? "/" + a.id : ""),
            data,
            a.id ? "PATCH" : "POST",
          );
          close();
          await render();
        },
      );
    });
  }
  async function requests() {
    const box = panel("On-demand requests"),
      rows = await api("/api/v1/requests");
    table(
      ["Selection", "Room", "State", "Actions"],
      rows.map((r) => [
        (r.source.sources || []).map((s) => s.title).join(", "),
        r.instance_id,
        r.state,
        actions(
          ["approve", "reject", "cancel"].map((decision) =>
            button(decision, async () => {
              await api(`/api/v1/requests/${r.id}/${decision}`, {});
              await render();
            }),
          ),
        ),
      ]),
      box,
    );
    const controls = panel("Room request policy"),
      room = await chooseRoom(controls, "on-demand");
    if (room) {
      const data = await api(`/api/v1/instances/${room.id}/request-policy`);
      form(
        controls,
        [
          {
            name: "approval",
            label: "Require staff approval",
            type: "checkbox",
            value: data.approval,
          },
          {
            name: "requireVoice",
            label: "Discord requester must be in this voice channel",
            type: "checkbox",
            value: data.requireVoice,
          },
          {
            name: "cooldownSeconds",
            label: "Cooldown (seconds)",
            type: "number",
            value: data.cooldownSeconds ?? 15,
          },
          {
            name: "dailyLimit",
            label: "Requests per user per day",
            type: "number",
            value: data.dailyLimit ?? 30,
          },
          {
            name: "maxItemsPerRequest",
            label: "Maximum episodes/items per request",
            type: "number",
            value: data.maxItemsPerRequest ?? 100,
          },
          {
            name: "dailyItems",
            label: "Requested items per user per day",
            type: "number",
            value: data.dailyItems ?? 500,
          },
        ],
        async (policy) => {
          await api(
            `/api/v1/instances/${room.id}/request-policy`,
            policy,
            "PUT",
          );
          tell("Request policy saved.");
        },
      );
    }
    panel("Guided Discord flow").append(
      n(
        "p",
        "Use /watch with a room and title. Select the real movie/show, navigate seasons/episodes, then confirm. /recommend returns catalog-backed suggestions. /queue, /nowplaying, /skip, /room and /request-cancel use the same permission policy.",
      ),
    );
  }
  async function permissions() {
    const data = await api("/api/v1/permissions"),
      box = panel("Permission matrix");
    box.append(
      n(
        "p",
        "Owner retains recovery access. Otherwise explicit user deny → user allow → role deny → role allow → guild default → web role default → deny. Discord membership and roles are refreshed before actions. IDs alone never grant access.",
      ),
    );
    const rooms = await api("/api/v1/instances");
    form(
      box,
      [
        { name: "guildId", label: "Guild ID (blank = global)" },
        {
          name: "instanceId",
          label: "Room scope",
          options: [{ value: "", label: "All rooms" }, ...roomOptions(rooms)],
        },
        {
          name: "subjectType",
          label: "Subject",
          options: ["user", "role", "guild"],
        },
        {
          name: "subjectId",
          label: "Discord user/role/guild ID or web user ID",
          required: true,
        },
        { name: "action", label: "Action", options: data.actions },
        { name: "effect", label: "Effect", options: ["allow", "deny"] },
      ],
      async (rule) => {
        await api("/api/v1/permissions", rule);
        await render();
      },
      "Add rule",
    );
    table(
      ["Subject", "Scope", "Action", "Effect", ""],
      data.rules.map((r) => [
        r.subject_type + ": " + r.subject_id,
        [r.guild_id, r.instance_id].filter(Boolean).join(" / ") || "Global",
        r.action,
        r.effect,
        button("Delete", async () => {
          await api("/api/v1/permissions/" + r.id, {}, "DELETE");
          await render();
        }),
      ]),
      box,
    );
    const users = panel("Web users");
    table(
      ["User", "Role", "ID"],
      data.users.map((u) => [u.username, u.role, u.id]),
      users,
    );
    form(
      users,
      [
        { name: "username", label: "Username", required: true },
        {
          name: "password",
          label: "Initial password (16+ characters)",
          type: "password",
          required: true,
        },
        {
          name: "role",
          label: "Role",
          options: ["viewer", "operator", "admin"],
        },
      ],
      async (data) => {
        await api("/api/v1/users", data);
        await render();
      },
      "Create web user",
    );
  }
  async function aiScreen() {
    const data = await api("/api/v1/ai"),
      rooms = await api("/api/v1/instances"),
      box = panel("Optional catalog concierge");
    box.append(
      n(
        "p",
        "AI never controls playback directly. Every result must exist in the permitted catalog, and queueing requires confirmation. Disabled or unconfigured AI falls back to deterministic catalog search. No conversation history is retained.",
      ),
    );
    form(
      box,
      [
        {
          name: "enabled",
          label: "Enable external AI",
          type: "checkbox",
          value: data.enabled,
        },
        {
          name: "endpoint",
          label: "OpenAI-compatible API base URL",
          type: "url",
          value: data.endpoint,
        },
        { name: "model", label: "Compatible model ID", value: data.model },
        {
          name: "credential",
          label: "API key (blank retains existing)",
          type: "password",
        },
        {
          name: "allowPrivate",
          label:
            "Explicitly allow this configured endpoint on a private network",
          type: "checkbox",
          value: data.allowPrivate,
        },
        {
          name: "allowedRooms",
          label: "Allowed rooms (empty = all authorized rooms)",
          options: roomOptions(rooms),
          multiple: true,
          value: data.allowedRooms,
        },
        {
          name: "dailyCalls",
          label: "Maximum external requests/day",
          type: "number",
          value: data.dailyCalls || 30,
        },
        {
          name: "maxTokens",
          label: "Maximum output tokens/round",
          type: "number",
          value: data.maxTokens || 400,
        },
        {
          name: "dailyTokenBudget",
          label: "Conservative daily token reservation cap",
          type: "number",
          value: data.dailyTokenBudget || 50000,
        },
      ],
      async (settings) => {
        if (!settings.credential) delete settings.credential;
        await api("/api/v1/ai", settings, "PUT");
        tell("AI settings saved. Use the recommendation form to test.");
      },
    );
    const test = panel("Ask for suggestions");
    form(
      test,
      [
        {
          name: "instanceId",
          label: "Target room",
          options: roomOptions(rooms.filter((r) => r.mode === "on-demand")),
        },
        {
          name: "description",
          label: "What would you like to watch?",
          type: "textarea",
          required: true,
        },
      ],
      async (input) => {
        const result = await api("/api/v1/ai/recommend", input);
        $("suggestions")?.remove();
        const out = n("div");
        out.id = "suggestions";
        out.append(n("p", result.message));
        for (const item of result.items)
          out.append(
            actions([
              n("span", item.title + (item.year ? " · " + item.year : "")),
              button("Request", () =>
                confirmAction(
                  `Request ${item.title} in this room?`,
                  async () => {
                    const request = await api("/api/v1/requests", {
                      instanceId: input.instanceId,
                      selection: {
                        providerId: item.providerId,
                        itemId: item.id,
                      },
                      confirm: true,
                    });
                    tell(`Request ${request.state}`);
                  },
                ),
              ),
            ]),
          );
        test.append(out);
      },
      "Get real catalog matches",
    );
  }
  async function system() {
    const data = await api("/api/v1/system"),
      settings = await api("/api/v1/settings"),
      box = panel("System health");
    box.append(
      n(
        "p",
        `Supervisor RSS ${Math.round(data.rss / 1048576)} MB · ${data.workers.length} configured workers · Software encoding default · GPU device ${data.gpu.deviceExposed ? "exposed (not proof of usable acceleration)" : "not exposed"}`,
      ),
    );
    table(
      ["Worker", "State", "RSS", "CPU", "FFmpeg"],
      data.workers.map((w) => [
        w.id,
        w.state,
        w.metrics?.rss ? Math.round(w.metrics.rss / 1048576) + " MB" : "—",
        w.metrics?.cpuPercent !== undefined ? w.metrics.cpuPercent + "%" : "—",
        w.metrics?.ffmpeg ? "Active" : "Idle",
      ]),
      box,
    );
    const config = panel("Access & resource limits");
    form(
      config,
      [
        {
          name: "origin",
          label: "Dashboard origin (localhost HTTP or HTTPS)",
          value: settings.origin,
          required: true,
        },
        {
          name: "trustedProxy",
          label: "Trusted proxy IP/CIDR, loopback, or blank",
          value: settings.trustedProxy,
        },
        {
          name: "sourceOrigins",
          label:
            "Allowed direct-media origins (comma separated; YouTube/Twitch built in)",
          value: settings.sourceOrigins?.join(", "),
        },
        {
          name: "maxWorkers",
          label: "Maximum active workers",
          type: "number",
          value: settings.limits.maxWorkers,
        },
        {
          name: "maxFfmpeg",
          label: "Maximum simultaneous encoders",
          type: "number",
          value: settings.limits.maxFfmpeg,
        },
        {
          name: "maxWorkerRSSMB",
          label: "Maximum worker process RSS (MB; excludes FFmpeg child)",
          type: "number",
          value: settings.limits.maxWorkerRSSMB || 1024,
        },
      ],
      async (data) => {
        data.sourceOrigins = data.sourceOrigins
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean);
        await api("/api/v1/settings", data, "PUT");
        tell(
          "Settings saved. If the origin changed, open that exact address and sign in again.",
        );
      },
    );
    const security = panel("Account security");
    form(
      security,
      [
        {
          name: "currentPassword",
          label: "Current password",
          type: "password",
          required: true,
        },
        {
          name: "password",
          label: "New unique password",
          type: "password",
          required: true,
        },
      ],
      async (data) => {
        await api("/api/v1/auth/password", data);
        location.assign("/login");
      },
      "Change password & revoke sessions",
    );
    security.append(
      actions([
        button("Sign out all my sessions", async () => {
          await api("/api/v1/auth/revoke-sessions", {});
          location.assign("/login");
        }),
        button("Rotate vault key", () =>
          confirmAction(
            "Rotate encrypted credential keys? Keep an encrypted backup for recovery.",
            async () => {
              await api("/api/v1/vault/rotate", {});
              tell("Vault key rotated.");
            },
          ),
        ),
      ]),
    );
    const backup = panel("Encrypted backup / restore");
    backup.append(
      n(
        "p",
        "Export includes users, settings and encrypted credentials plus key material inside a passphrase-encrypted envelope. Local video files are not included. A restore replaces accounts/settings and revokes sessions. Stop every worker and command connection first.",
        "warning",
      ),
    );
    form(
      backup,
      [
        {
          name: "passphrase",
          label: "Recovery passphrase (20+ characters)",
          type: "password",
          required: true,
        },
      ],
      async (data) => {
        const result = await api("/api/v1/backups/export", data);
        const link = n("a");
        const url = URL.createObjectURL(
          new Blob([JSON.stringify(result)], { type: "application/json" }),
        );
        link.href = url;
        link.download = "streambot-tv-encrypted-backup.json";
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        tell(
          "Encrypted backup exported. Store the recovery passphrase separately.",
        );
      },
      "Export encrypted backup",
    );
    const file = n("input");
    file.type = "file";
    file.accept = ".json";
    file.setAttribute("aria-label", "Encrypted backup file");
    backup.append(file);
    form(
      backup,
      [
        {
          name: "passphrase",
          label: "Backup recovery passphrase",
          type: "password",
          required: true,
        },
      ],
      async (data) => {
        if (!file.files[0]) throw Error("Choose an encrypted backup file");
        if (file.files[0].size > 30 * 1024 * 1024)
          throw Error("Backup too large");
        await confirmAction(
          "Replace ALL accounts, settings and credentials from this backup and sign everyone out?",
          async () => {
            const body = JSON.parse(await file.files[0].text());
            await api("/api/v1/backups/import", {
              backup: body,
              passphrase: data.passphrase,
              confirm: true,
            });
            location.assign("/login");
          },
        );
      },
      "Import & replace configuration",
    );
    const migration = panel("One-time legacy import"),
      summary = await api("/api/v1/migration");
    migration.append(n("p", summary.warning));
    if (summary.imported)
      migration.append(n("p", "Legacy import already completed."));
    else {
      migration.append(
        n(
          "p",
          `${summary.providers.length} legacy media source(s) · Discord token ${summary.discordConfigured ? "detected" : "not configured"}`,
        ),
      );
      form(
        migration,
        [
          {
            name: "createInstance",
            label:
              "Import the legacy playback account as a stopped instance for review",
            type: "checkbox",
          },
        ],
        async (data) =>
          confirmAction(
            "Import detected legacy connections into the encrypted vault without deleting your old files?",
            async () => {
              await api("/api/v1/migration", { ...data, confirm: true });
              await render();
            },
          ),
        "Review & import",
      );
    }
    const secretBox = panel("Credential metadata"),
      secrets = await api("/api/v1/secrets");
    table(
      ["Purpose", "Owner", "Status", ""],
      secrets.map((secret) => [
        secret.purpose,
        secret.owner,
        secret.inUse ? "In use" : "Retained / unused",
        secret.inUse
          ? n("span", "Manage on connection")
          : button(
              "Delete unused",
              () =>
                confirmAction(
                  "Permanently remove this unused encrypted credential?",
                  async () => {
                    await api(
                      "/api/v1/secrets/" + secret.id,
                      { confirm: true },
                      "DELETE",
                    );
                    await render();
                  },
                ),
              "danger",
            ),
      ]),
      secretBox,
    );
    const uploadLegacy = panel("Import legacy files through the browser");
    uploadLegacy.append(
      n(
        "p",
        "Choose existing .env and media-servers.json files. Preview returns only a redacted summary. Import copies credentials into the encrypted vault and never deletes the originals.",
      ),
    );
    const envFile = n("input");
    envFile.type = "file";
    envFile.setAttribute("aria-label", "Legacy environment file");
    const providerFile = n("input");
    providerFile.type = "file";
    providerFile.accept = ".json";
    providerFile.setAttribute("aria-label", "Legacy provider JSON file");
    uploadLegacy.append(
      n("label", "Legacy .env"),
      envFile,
      n("label", "Legacy media-servers.json"),
      providerFile,
    );
    let pendingImport;
    uploadLegacy.append(
      button("Preview import", async () => {
        if (
          !envFile.files[0] ||
          !providerFile.files[0] ||
          envFile.files[0].size > 131072 ||
          providerFile.files[0].size > 131072
        )
          throw Error("Choose both legacy files under 128 KiB each");
        pendingImport = {
          environment: await envFile.files[0].text(),
          config: JSON.parse(await providerFile.files[0].text()),
        };
        const preview = await api("/api/v1/migration/upload", pendingImport);
        tell(
          `${preview.providers.length} provider(s), playback credential ${preview.discordConfigured ? "detected" : "absent"}. Review, then confirm import.`,
        );
      }),
    );
    form(
      uploadLegacy,
      [
        {
          name: "createInstance",
          label: "Also create a stopped legacy playback instance for review",
          type: "checkbox",
        },
      ],
      async (data) => {
        if (!pendingImport) throw Error("Preview the files first");
        await confirmAction(
          "Import these legacy credentials into the encrypted vault without changing original files?",
          async () => {
            await api("/api/v1/migration/upload", {
              ...pendingImport,
              ...data,
              confirm: true,
            });
            pendingImport = undefined;
            envFile.value = "";
            providerFile.value = "";
            await render();
          },
        );
      },
      "Confirm legacy import",
    );
    const audit = panel("Redacted audit trail"),
      events = await api("/api/v1/audit");
    table(
      ["Time", "Actor", "Action", "Target", "Outcome"],
      events.map((e) => [
        new Date(e.created_at).toLocaleString(),
        e.actor,
        e.action,
        e.target,
        e.outcome,
      ]),
      audit,
    );
  }
  window.addEventListener("popstate", () => {
    navigation();
    void render();
  });
  void initialize().catch((e) => tell(e.message, true));
})();
