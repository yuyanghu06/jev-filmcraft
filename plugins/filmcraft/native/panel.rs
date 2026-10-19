//! Optional FilmCraft sidebar. All networking and presentation code lives in the plugin.
use crate::icons::{self, Icon};
use crate::theme::Tokens;
use crate::widgets;
use egui::{Rect, Response, RichText, Stroke, StrokeKind, Ui, UiBuilder, pos2, vec2};
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

type Reply = (&'static str, Result<Value, String>);
const PROVIDERS: [(&str, &str); 5] =
    [("claude", "Claude"), ("chatgpt", "ChatGPT"), ("jev", "Jev · Experimental"), ("codex", "Codex"), ("claude-code", "Claude Code")];

pub struct ChatPanel {
    url: String,
    token: String,
    open: bool,
    focused: bool,
    width: f32,
    provider: String,
    providers: Value,
    installs: Value,
    settings: bool,
    model: String,
    key: String,
    prompt: String,
    transcript: Vec<(String, String)>,
    session: Option<String>,
    run: Option<String>,
    seen: usize,
    status: String,
    pending: Option<Receiver<Reply>>,
    last_poll: Instant,
}

impl Default for ChatPanel {
    fn default() -> Self {
        Self {
            url: std::env::var("FILMCRAFT_CHAT_URL").unwrap_or_default(),
            token: std::env::var("FILMCRAFT_CHAT_TOKEN").unwrap_or_default(),
            open: true,
            focused: false,
            width: 380.0,
            provider: "claude".into(),
            providers: Value::Null,
            installs: Value::Null,
            settings: false,
            model: String::new(),
            key: String::new(),
            prompt: String::new(),
            transcript: Vec::new(),
            session: None,
            run: None,
            seen: 0,
            status: "Connecting…".into(),
            pending: None,
            last_poll: Instant::now() - Duration::from_secs(10),
        }
    }
}

impl ChatPanel {
    pub fn inspect(&self) -> Value {
        json!({"enabled": !self.url.is_empty(), "open": self.open, "provider": self.provider, "status": self.status,
            "running": self.run.is_some(), "settings": self.settings, "messages": self.transcript.len()})
    }
    fn request(&mut self, kind: &'static str, route: String, payload: Option<Value>, ctx: &egui::Context) {
        if self.pending.is_some() {
            return;
        }
        let (sender, receiver) = mpsc::channel();
        let url = self.url.clone();
        let token = self.token.clone();
        let ctx = ctx.clone();
        self.pending = Some(receiver);
        std::thread::spawn(move || {
            let result = request_json(&url, &token, &route, payload);
            let _ = sender.send((kind, result));
            ctx.request_repaint();
        });
    }
    fn provider_info(&self) -> Option<&Value> {
        self.providers.as_array()?.iter().find(|v| v["id"] == self.provider)
    }
    fn configured(&self) -> bool {
        self.provider_info().and_then(|v| v["configured"].as_bool()).unwrap_or(false)
    }
    fn load_model(&mut self) {
        self.model = self.provider_info().and_then(|v| v["model"].as_str()).unwrap_or("").to_owned();
    }
    fn receive(&mut self) {
        let Some((kind, result)) = self.pending.as_ref().and_then(|r| r.try_recv().ok()) else {
            return;
        };
        self.pending = None;
        self.last_poll = Instant::now();
        match result {
            Err(message) => {
                self.status = message.clone();
                if kind == "send" {
                    self.transcript.push(("error".into(), message));
                }
            }
            Ok(value) if kind == "providers" || kind == "config" => {
                self.providers = value["providers"].clone();
                if value.get("installs").is_some() {
                    self.installs = value["installs"].clone();
                }
                self.load_model();
                self.key.clear();
                self.status = if kind == "config" { "Settings saved for this session" } else { "Ready" }.into();
            }
            Ok(value) => {
                self.session = value["session"].as_str().map(str::to_owned);
                if let Some(events) = value["events"].as_array() {
                    for event in events.iter().skip(self.seen) {
                        self.transcript.push((event["kind"].as_str().unwrap_or("assistant").into(), event["text"].as_str().unwrap_or("").into()));
                    }
                    self.seen = events.len();
                }
                let status = value["status"].as_str().unwrap_or("error");
                self.status = status.into();
                self.run = if status == "running" || status == "stopping" { value["id"].as_str().map(str::to_owned) } else { None };
                if kind == "send" {
                    self.prompt.clear();
                }
            }
        }
    }
    fn new_chat(&mut self) {
        self.session = None;
        self.transcript.clear();
        self.seen = 0;
        self.status = "Ready".into();
    }

    pub fn show(&mut self, ui: &mut Ui, body: Rect, t: &Tokens, register: &mut impl FnMut(&str, &Response, &str)) -> Rect {
        if self.url.is_empty() {
            return body;
        }
        self.receive();
        let ctx = ui.ctx().clone();
        if self.pending.is_none() && self.last_poll.elapsed() > Duration::from_millis(700) {
            if let Some(run) = self.run.clone() {
                self.request("poll", format!("/v1/chat/runs/{run}"), None, &ctx);
            } else if self.providers.is_null() {
                self.request("providers", "/v1/chat/providers".into(), None, &ctx);
            }
        }
        ctx.request_repaint_after(Duration::from_millis(250));
        let width = if self.open { self.width.min(body.width() * 0.48).max(250.0) } else { t.tab_h };
        let panel = Rect::from_min_max(egui::pos2(body.max.x - width, body.min.y), body.max);
        ui.painter().rect_filled(panel, t.radius, t.panel_bg);
        if let Some(point) = ui.input(|i| i.pointer.press_origin().filter(|_| i.pointer.any_pressed())) {
            self.focused = panel.contains(point);
        }
        let header = Rect::from_min_size(panel.min, vec2(panel.width(), t.tab_h));
        ui.painter().rect_filled(header, t.radius, t.tab_bg);
        if !self.open {
            ui.scope_builder(UiBuilder::new().max_rect(header.shrink(4.0)), |ui| {
                let r = toolbar_icon(ui, Icon::Chat, false, t, "Open assistant");
                register("chat.open", &r, "Open chat");
                if r.clicked() {
                    self.open = true;
                }
            });
            return Rect::from_min_max(body.min, pos2(panel.min.x - t.gap, body.max.y));
        }
        if self.open {
            let gutter = Rect::from_min_max(panel.min, egui::pos2(panel.min.x + 5.0, panel.max.y));
            let response = ui.interact(gutter, ui.id().with("chat.resize"), egui::Sense::drag());
            register("chat.resize", &response, "Resize chat");
            if response.dragged() {
                self.width = (self.width - response.drag_delta().x).clamp(280.0, 650.0);
            }
            response.on_hover_cursor(egui::CursorIcon::ResizeHorizontal);
        }
        // Match the editor's 32-point tab strip, 12-point title and one-point active underline.
        let title = ui.painter().layout_no_wrap("Assistant".into(), Tokens::ui(12.0), t.tab_text_active);
        let label_x = panel.min.x + 20.0;
        let underline_y = header.min.y + 23.0;
        ui.painter().line_segment([pos2(label_x, underline_y), pos2(label_x + title.size().x, underline_y)], Stroke::new(1.0, t.tab_text_active));
        ui.painter().galley(pos2(label_x, header.center().y - title.size().y / 2.0), title, t.tab_text_active);
        let toolbar = Rect::from_min_max(pos2(header.max.x - 92.0, header.min.y + 4.0), pos2(header.max.x - 4.0, header.max.y - 4.0));
        ui.scope_builder(UiBuilder::new().max_rect(toolbar).layout(egui::Layout::right_to_left(egui::Align::Center)), |ui| {
            let r = toolbar_icon(ui, Icon::ChevronRight, false, t, "Collapse assistant");
            register("chat.close", &r, "Collapse chat");
            if r.clicked() {
                self.open = false;
            }
            if self.provider != "codex" && self.provider != "claude-code" {
                ui.add_enabled_ui(self.run.is_none() && self.pending.is_none(), |ui| {
                    let r = toolbar_icon(ui, Icon::Gear, self.settings, t, "Provider settings");
                    register("chat.settings", &r, "Provider settings");
                    if r.clicked() {
                        self.settings = !self.settings;
                    }
                    let r = toolbar_icon(ui, Icon::Plus, false, t, "New chat");
                    register("chat.new", &r, "New chat");
                    if r.clicked() {
                        self.new_chat();
                    }
                });
            }
        });
        let content = Rect::from_min_max(pos2(panel.min.x + 12.0, header.max.y + 8.0), panel.max - vec2(12.0, 8.0));
        ui.scope_builder(UiBuilder::new().max_rect(content), |ui| {
            let old_provider = self.provider.clone();
            ui.add_enabled_ui(self.run.is_none() && self.pending.is_none(), |ui| {
                let selected = PROVIDERS.iter().find(|p| p.0 == self.provider).map(|p| p.1).unwrap_or("Claude");
                ui.horizontal(|ui| {
                    ui.label(RichText::new("Provider").color(t.text_dim));
                    let combo = egui::ComboBox::from_id_salt("chat.provider").selected_text(selected).width(ui.available_width()).show_ui(ui, |ui| {
                        for (id, label) in PROVIDERS {
                            let r = ui.selectable_value(&mut self.provider, id.into(), label);
                            register(&format!("chat.provider.{id}"), &r, label);
                        }
                    });
                    register("chat.provider", &combo.response, "Choose provider");
                });
            });
            if old_provider != self.provider {
                self.new_chat();
                self.key.clear();
                self.load_model();
                self.settings = false;
            }
            ui.add_space(8.0);
            if self.provider == "codex" || self.provider == "claude-code" {
                ui.label(RichText::new("Connect your coding agent").font(Tokens::semibold(12.0)));
                ui.label("Paste this command in your terminal, then restart the agent. Keep this FilmCraft window open so it can edit this project.");
                ui.add_space(8.0);
                let script = self.installs[&self.provider].as_str().unwrap_or("Connecting to plugin…").to_owned();
                egui::Frame::new().fill(t.field_bg).stroke(Stroke::new(1.0, t.field_border)).corner_radius(t.radius_sm).inner_margin(8).show(ui, |ui| {
                    egui::ScrollArea::vertical().id_salt("chat.install").max_height(250.0).show(ui, |ui| {
                        ui.add(egui::Label::new(RichText::new(&script).font(Tokens::mono(11.0)).color(t.text)).wrap());
                    });
                });
                let r = ui.button("Copy install command");
                register("chat.install.copy", &r, "Copy MCP install command");
                if r.clicked() {
                    ctx.copy_text(script);
                    self.status = "Install command copied".into();
                }
                ui.add_space(8.0);
                ui.separator();
                ui.label(RichText::new("MCP tools share the live timeline, project state and Undo history.").color(t.text_dim));
                ui.label(RichText::new("Chat with Codex or Claude Code in its own app or terminal.").color(t.text_dim));
                ui.add_space(8.0);
                ui.label(RichText::new(&self.status).small().color(t.text_dim));
                return;
            }
            ui.horizontal(|ui| {
                let (dot, _) = ui.allocate_exact_size(vec2(8.0, 14.0), egui::Sense::hover());
                ui.painter().circle_filled(dot.center(), 2.5, if self.configured() { t.render_green } else { t.text_faint });
                ui.label(RichText::new(if self.configured() { "API key connected" } else { "Add an API key in settings" }).small().color(t.text_dim));
            });
            if self.settings {
                ui.separator();
                ui.label(RichText::new("Provider settings").font(Tokens::semibold(12.0)));
                ui.label(RichText::new("Model").color(t.text_dim));
                let r = ui.add(egui::TextEdit::singleline(&mut self.model).desired_width(f32::INFINITY));
                register("chat.model", &r, "Model");
                ui.label(RichText::new("API key").color(t.text_dim));
                let r = ui.add(egui::TextEdit::singleline(&mut self.key).password(true).desired_width(f32::INFINITY).hint_text("Paste key to replace"));
                register("chat.key", &r, "API key");
                ui.horizontal(|ui| {
                    let r = ui.add_enabled(self.pending.is_none() && !self.model.is_empty(), egui::Button::new("Apply"));
                    register("chat.settings.apply", &r, "Apply settings");
                    if r.clicked() {
                        let mut payload = json!({"provider": self.provider, "model": self.model});
                        if !self.key.is_empty() {
                            payload["apiKey"] = Value::String(self.key.clone());
                        }
                        self.request("config", "/v1/chat/config".into(), Some(payload), &ctx);
                        self.key.clear();
                    }
                    let r = ui.add_enabled(self.pending.is_none(), egui::Button::new("Clear key"));
                    register("chat.settings.clear", &r, "Clear API key");
                    if r.clicked() {
                        self.request("config", "/v1/chat/config".into(), Some(json!({"provider": self.provider, "apiKey": ""})), &ctx);
                    }
                });
                ui.label(RichText::new("Keys entered here last for this session.").small().color(t.text_dim));
            }
            if self.provider == "jev" {
                ui.label(RichText::new("Experimental · Jev vision enabled").small().color(t.text_dim));
                ui.label(RichText::new("Quote text and include exact values. Complex arguments accept JSON.").small().color(t.text_dim));
            }
            ui.separator();
            let footer_h = 134.0;
            let transcript_h = (ui.available_height() - footer_h).max(60.0);
            egui::ScrollArea::vertical()
                .id_salt("chat.transcript")
                .auto_shrink([false, false])
                .max_height(transcript_h)
                .min_scrolled_height(transcript_h)
                .stick_to_bottom(true)
                .show(ui, |ui| {
                    if self.transcript.is_empty() {
                        ui.add_space(12.0);
                        ui.label(RichText::new("Edit by describing what you want").font(Tokens::semibold(12.0)));
                        ui.add_space(8.0);
                        ui.label("“Add a marker at 1 second named \"Opening\".”");
                        ui.label("“Show the timeline and suggest a shorter cut.”");
                        ui.add_space(12.0);
                        ui.label(RichText::new("Edits appear in the timeline. Review tool activity here and use FilmCraft Undo to revert.").color(t.text_dim));
                    }
                    for (i, (kind, text)) in self.transcript.iter().enumerate() {
                        ui.push_id(i, |ui| {
                            if kind == "tool" || kind == "result" {
                                let label = if kind == "tool" {
                                    text.lines().next().unwrap_or("Tool").trim_start_matches("filmcraft_").replace('_', " ")
                                } else {
                                    "Tool result".into()
                                };
                                let id = ui.id().with("chat.event.open");
                                let open = ui.data(|d| d.get_temp::<bool>(id)).unwrap_or(false);
                                let (r, open) = widgets::section_header(ui, id, &label, open, t, false);
                                register(&format!("chat.event.{i}"), &r, &label);
                                ui.data_mut(|d| d.insert_temp(id, open));
                                if open {
                                    ui.add(egui::Label::new(RichText::new(text).font(Tokens::mono(11.0)).color(t.text_dim)).wrap());
                                }
                            } else {
                                ui.label(
                                    RichText::new(if kind == "user" {
                                        "You"
                                    } else if kind == "error" {
                                        "Status"
                                    } else {
                                        "Assistant"
                                    })
                                    .font(Tokens::semibold(12.0))
                                    .color(if kind == "error" { t.danger } else { t.text_dim }),
                                );
                                ui.add(egui::Label::new(text).wrap());
                                ui.add_space(8.0);
                            }
                        });
                    }
                });
            ui.separator();
            let r = ui.add_enabled(
                self.run.is_none(),
                egui::TextEdit::multiline(&mut self.prompt).desired_rows(3).desired_width(f32::INFINITY).char_limit(16000).hint_text("Describe an edit…"),
            );
            register("chat.prompt", &r, "Chat message");
            ui.horizontal(|ui| {
                let r = ui.add_enabled(
                    self.run.is_none() && self.pending.is_none() && !self.prompt.trim().is_empty() && self.configured(),
                    egui::Button::new("Send"),
                );
                register("chat.send", &r, "Send message");
                if r.clicked() {
                    self.seen = 0;
                    let mut payload = json!({"provider": self.provider, "message": self.prompt});
                    if let Some(session) = &self.session {
                        payload["session"] = Value::String(session.clone());
                    }
                    self.status = "Starting…".into();
                    self.request("send", "/v1/chat/runs".into(), Some(payload), &ctx);
                }
                let r = ui.add_enabled(self.run.is_some() && self.pending.is_none(), egui::Button::new("Stop"));
                register("chat.stop", &r, "Stop after current tool");
                if r.clicked()
                    && let Some(run) = self.run.clone()
                {
                    self.request("cancel", format!("/v1/chat/runs/{run}/cancel"), Some(json!({})), &ctx);
                }
                ui.label(RichText::new(&self.status).small().color(t.text_dim));
            });
            ui.label(RichText::new("Selected provider receives messages, project context and tool images.").small().color(t.text_dim));
        });
        if self.focused {
            ui.painter().rect_stroke(panel, t.radius, Stroke::new(1.0, t.focus), StrokeKind::Inside);
        }
        Rect::from_min_max(body.min, egui::pos2(panel.min.x - t.gap, body.max.y))
    }
}

fn toolbar_icon(ui: &mut Ui, icon: Icon, active: bool, t: &Tokens, label: &str) -> Response {
    let response = icons::button(ui, icon, 24.0, active, t, label);
    response.widget_info(|| egui::WidgetInfo::labeled(egui::WidgetType::Button, response.enabled(), label));
    if response.has_focus() {
        ui.painter().rect_stroke(response.rect, t.radius_sm, Stroke::new(1.0, t.focus), StrokeKind::Inside);
    }
    response
}

fn request_json(url: &str, token: &str, route: &str, payload: Option<Value>) -> Result<Value, String> {
    let address: SocketAddr = url.strip_prefix("http://").ok_or("Chat requires a local HTTP address")?.parse().map_err(|_| "Invalid chat address")?;
    if !address.ip().is_loopback() || token.contains(['\r', '\n']) {
        return Err("Invalid local chat configuration".into());
    }
    let mut socket = TcpStream::connect_timeout(&address, Duration::from_secs(2)).map_err(|_| "Waiting for chat service…")?;
    socket.set_read_timeout(Some(Duration::from_secs(5))).map_err(|e| e.to_string())?;
    socket.set_write_timeout(Some(Duration::from_secs(5))).map_err(|e| e.to_string())?;
    let method = if payload.is_some() { "POST" } else { "GET" };
    let body = payload.map(|p| p.to_string()).unwrap_or_default();
    let request = format!(
        "{method} {route} HTTP/1.1\r\nHost: {address}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    socket.write_all(request.as_bytes()).map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    socket.take(8_000_001).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() > 8_000_000 {
        return Err("Chat response too large".into());
    }
    let response = String::from_utf8(bytes).map_err(|e| e.to_string())?;
    let (_, body) = response.split_once("\r\n\r\n").ok_or("Invalid chat response")?;
    let value: Value = serde_json::from_str(body).map_err(|e| e.to_string())?;
    if let Some(message) = value["error"]["message"].as_str() {
        return Err(message.to_owned());
    }
    Ok(value)
}
