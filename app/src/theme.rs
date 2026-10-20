//! 介面主題系統 (設計定稿 design/palettes.md)。
//!
//! 五套淺色主題, 色值以 WCAG 對比實算定稿, 施工不得自行改色。
//! 主題選擇存進 ShellSettings.theme (字串), 啟動時 (含 --autostart)
//! 在第一幀之前套用, 不閃預設色。頁面繪製一律吃 App.palette,
//! 不得再引用寫死的顏色常數 (QR 碼黑白為功能必需, 不在此限)。

use egui::Color32;

const fn rgb(r: u8, g: u8, b: u8) -> Color32 {
    Color32::from_rgb(r, g, b)
}

/// 一套主題的完整色票 (欄位對應 design/palettes.md 的角色表)。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Palette {
    pub bg: Color32,
    pub sidebar: Color32,
    pub card: Color32,
    pub primary: Color32,
    pub primary_hover: Color32,
    pub secondary: Color32,
    pub accent: Color32,
    pub text_main: Color32,
    pub text_sub: Color32,
    /// 狀態圓點/圖示用亮版。
    pub ok: Color32,
    /// 狀態文字用深版 (對比 >= 4.5)。
    pub ok_text: Color32,
    pub warn: Color32,
    pub warn_text: Color32,
    /// 危險色圓點與文字兩用 (定稿值本身對比已足)。
    pub bad: Color32,
    pub idle: Color32,
    pub border: Color32,
}

impl Palette {
    /// 連結色: 次要色; 黑白主題改主文字 (egui hyperlink 另有底線慣例)。
    pub fn hyperlink(&self, theme: ThemeId) -> Color32 {
        if theme == ThemeId::Mono {
            self.text_main
        } else {
            self.secondary
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ThemeId {
    Forest,
    Ocean,
    Sakura,
    Violet,
    Mono,
}

impl ThemeId {
    pub const ALL: [ThemeId; 5] = [
        ThemeId::Forest,
        ThemeId::Ocean,
        ThemeId::Sakura,
        ThemeId::Violet,
        ThemeId::Mono,
    ];

    /// 持久化字串 (ShellSettings.theme)。
    pub fn as_str(&self) -> &'static str {
        match self {
            ThemeId::Forest => "forest",
            ThemeId::Ocean => "ocean",
            ThemeId::Sakura => "sakura",
            ThemeId::Violet => "violet",
            ThemeId::Mono => "mono",
        }
    }

    /// 未知字串退回預設森林綠, 不 panic。
    pub fn from_str(s: &str) -> ThemeId {
        match s {
            "ocean" => ThemeId::Ocean,
            "sakura" => ThemeId::Sakura,
            "violet" => ThemeId::Violet,
            "mono" => ThemeId::Mono,
            _ => ThemeId::Forest,
        }
    }

    pub fn label(&self) -> &'static str {
        match self {
            ThemeId::Forest => "森林綠",
            ThemeId::Ocean => "海洋藍",
            ThemeId::Sakura => "櫻花粉",
            ThemeId::Violet => "紫羅蘭紫",
            ThemeId::Mono => "黑白簡約",
        }
    }

    pub fn palette(&self) -> Palette {
        match self {
            ThemeId::Forest => Palette {
                bg: rgb(0xF3, 0xF8, 0xF3),
                sidebar: rgb(0xE6, 0xF0, 0xE6),
                card: rgb(0xFF, 0xFF, 0xFF),
                primary: rgb(0x0C, 0x51, 0x3D),
                primary_hover: rgb(0x0A, 0x42, 0x32),
                secondary: rgb(0x2E, 0x7D, 0x5B),
                accent: rgb(0xC9, 0xA2, 0x27),
                text_main: rgb(0x1E, 0x2B, 0x22),
                text_sub: rgb(0x55, 0x68, 0x5B),
                ok: rgb(0x1D, 0xA4, 0x57),
                ok_text: rgb(0x14, 0x6C, 0x3A),
                warn: rgb(0xD9, 0x8A, 0x00),
                warn_text: rgb(0x8F, 0x57, 0x00),
                bad: rgb(0xC0, 0x39, 0x2B),
                idle: rgb(0x95, 0x9A, 0x9D),
                border: rgb(0xD8, 0xE4, 0xD8),
            },
            ThemeId::Ocean => Palette {
                bg: rgb(0xF2, 0xF7, 0xFB),
                sidebar: rgb(0xE2, 0xED, 0xF7),
                card: rgb(0xFF, 0xFF, 0xFF),
                primary: rgb(0x0B, 0x5F, 0xA5),
                primary_hover: rgb(0x09, 0x4E, 0x87),
                secondary: rgb(0x2E, 0x86, 0xC8),
                accent: rgb(0x17, 0xA3, 0x98),
                text_main: rgb(0x15, 0x2A, 0x3D),
                text_sub: rgb(0x4E, 0x6A, 0x82),
                ok: rgb(0x17, 0x8A, 0x4C),
                ok_text: rgb(0x14, 0x6C, 0x3A),
                warn: rgb(0xD9, 0x8A, 0x00),
                warn_text: rgb(0x8F, 0x57, 0x00),
                bad: rgb(0xC0, 0x39, 0x2B),
                idle: rgb(0x8F, 0xA3, 0xB3),
                border: rgb(0xD2, 0xE0, 0xEE),
            },
            ThemeId::Sakura => Palette {
                bg: rgb(0xFD, 0xF5, 0xF8),
                sidebar: rgb(0xFA, 0xE7, 0xEF),
                card: rgb(0xFF, 0xFF, 0xFF),
                primary: rgb(0xB0, 0x2A, 0x5E),
                primary_hover: rgb(0x96, 0x23, 0x4F),
                secondary: rgb(0xC9, 0x5C, 0x8C),
                accent: rgb(0xF2, 0xB8, 0xCE),
                text_main: rgb(0x38, 0x22, 0x2E),
                text_sub: rgb(0x7A, 0x55, 0x68),
                ok: rgb(0x1E, 0x7D, 0x4F),
                ok_text: rgb(0x1E, 0x7D, 0x4F),
                warn: rgb(0xD9, 0x8A, 0x00),
                warn_text: rgb(0xA8, 0x64, 0x00),
                bad: rgb(0xB3, 0x26, 0x1E),
                idle: rgb(0xA8, 0x93, 0x9D),
                border: rgb(0xF2, 0xD3, 0xDF),
            },
            ThemeId::Violet => Palette {
                bg: rgb(0xF6, 0xF3, 0xFC),
                sidebar: rgb(0xEA, 0xE3, 0xF8),
                card: rgb(0xFF, 0xFF, 0xFF),
                primary: rgb(0x5E, 0x35, 0xB1),
                primary_hover: rgb(0x4E, 0x2C, 0x94),
                secondary: rgb(0x8E, 0x6B, 0xC8),
                accent: rgb(0xC5, 0xB3, 0xEC),
                text_main: rgb(0x28, 0x20, 0x3F),
                text_sub: rgb(0x65, 0x5C, 0x86),
                ok: rgb(0x1E, 0x7D, 0x4F),
                ok_text: rgb(0x1E, 0x7D, 0x4F),
                warn: rgb(0xD9, 0x8A, 0x00),
                warn_text: rgb(0xA8, 0x64, 0x00),
                bad: rgb(0xB3, 0x26, 0x1E),
                idle: rgb(0x9A, 0x92, 0xB3),
                border: rgb(0xDC, 0xD1, 0xF0),
            },
            ThemeId::Mono => Palette {
                bg: rgb(0xF7, 0xF7, 0xF7),
                sidebar: rgb(0xEB, 0xEB, 0xEB),
                card: rgb(0xFF, 0xFF, 0xFF),
                primary: rgb(0x1B, 0x1B, 0x1B),
                primary_hover: rgb(0x00, 0x00, 0x00),
                secondary: rgb(0x5C, 0x5C, 0x5C),
                accent: rgb(0xBF, 0xBF, 0xBF),
                text_main: rgb(0x11, 0x11, 0x11),
                text_sub: rgb(0x5A, 0x5A, 0x5A),
                ok: rgb(0x2E, 0x7D, 0x32),
                ok_text: rgb(0x2E, 0x7D, 0x32),
                warn: rgb(0x9E, 0x62, 0x00),
                warn_text: rgb(0x9E, 0x62, 0x00),
                bad: rgb(0xB3, 0x26, 0x1E),
                idle: rgb(0x9E, 0x9E, 0x9E),
                border: rgb(0xD9, 0xD9, 0xD9),
            },
        }
    }
}

/// 把色票套進 egui Visuals (施工對照 implementation-notes.md 的對照表)。
/// 主按鈕採 `Button::fill(primary)` 在頁面端指定; 這裡負責全域 widget 三態、
/// 面板/視窗底色、選取與連結色。
pub fn apply_theme(ctx: &egui::Context, theme: ThemeId) {
    let pal = theme.palette();
    let mut v = egui::Visuals::light();
    v.panel_fill = pal.bg;
    v.window_fill = pal.card;
    v.extreme_bg_color = pal.card; // 輸入框底
    v.faint_bg_color = pal.sidebar;
    v.window_stroke = egui::Stroke::new(1.0, pal.border);
    v.selection.bg_fill = pal.primary;
    v.selection.stroke = egui::Stroke::new(1.0, Color32::WHITE);
    v.hyperlink_color = pal.hyperlink(theme);
    v.warn_fg_color = pal.warn_text;
    v.error_fg_color = pal.bad;

    v.widgets.noninteractive.bg_fill = Color32::TRANSPARENT;
    v.widgets.noninteractive.weak_bg_fill = pal.sidebar;
    v.widgets.noninteractive.bg_stroke = egui::Stroke::new(1.0, pal.border);
    v.widgets.noninteractive.fg_stroke = egui::Stroke::new(1.0, pal.text_main);

    v.widgets.inactive.bg_fill = pal.card;
    v.widgets.inactive.weak_bg_fill = pal.sidebar;
    v.widgets.inactive.bg_stroke = egui::Stroke::new(1.0, pal.border);
    v.widgets.inactive.fg_stroke = egui::Stroke::new(1.0, pal.text_main);

    v.widgets.hovered.bg_fill = pal.sidebar;
    v.widgets.hovered.weak_bg_fill = pal.sidebar;
    v.widgets.hovered.bg_stroke = egui::Stroke::new(1.0, pal.primary);
    v.widgets.hovered.fg_stroke = egui::Stroke::new(1.0, pal.text_main);

    v.widgets.active.bg_fill = pal.primary_hover;
    v.widgets.active.weak_bg_fill = pal.primary;
    v.widgets.active.bg_stroke = egui::Stroke::new(1.0, pal.primary_hover);
    v.widgets.active.fg_stroke = egui::Stroke::new(1.0, Color32::WHITE);

    v.widgets.open.bg_fill = pal.sidebar;
    v.widgets.open.weak_bg_fill = pal.sidebar;
    v.widgets.open.bg_stroke = egui::Stroke::new(1.0, pal.border);
    v.widgets.open.fg_stroke = egui::Stroke::new(1.0, pal.text_main);

    ctx.set_visuals(v);
}

/// 以指定 alpha 覆寫顏色 (側欄未選圖示片採主色 55%、hover 採主色淡底)。
pub fn with_alpha(c: Color32, alpha: u8) -> Color32 {
    Color32::from_rgba_unmultiplied(c.r(), c.g(), c.b(), alpha)
}
