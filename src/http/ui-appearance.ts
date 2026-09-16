/** Runs before the stylesheet to avoid a light flash when the saved theme is dark. */
export const appearanceBootstrap = String.raw`
    (() => {
      const key = "yourchar.appearance";
      const valid = value => ["system", "light", "dark"].includes(value) ? value : "system";
      const media = window.matchMedia("(prefers-color-scheme: dark)");
      let preference = "system";
      try { preference = valid(localStorage.getItem(key)); } catch {}
      const appearance = {
        preference,
        apply(value, persist = false) {
          this.preference = valid(value);
          const theme = this.preference === "system" ? (media.matches ? "dark" : "light") : this.preference;
          document.documentElement.dataset.theme = theme;
          document.documentElement.style.colorScheme = theme;
          document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#181818" : "#f5f5f5");
          if (persist) { try { localStorage.setItem(key, this.preference); } catch {} }
          window.dispatchEvent(new Event("yourchar:themechange"));
        }
      };
      window.yourcharAppearance = appearance;
      appearance.apply(preference);
      media.addEventListener("change", () => { if (appearance.preference === "system") appearance.apply("system"); });
      window.addEventListener("storage", event => { if (event.key === key || event.key === null) appearance.apply(valid(event.newValue)); });
    })();
`;

export const appearanceScript = String.raw`
    function updateAppearanceControls() {
      const appearance = window.yourcharAppearance;
      if (!appearance) return;
      document.querySelectorAll("[data-theme-choice]").forEach(button => {
        button.setAttribute("aria-pressed", String(button.dataset.themeChoice === appearance.preference));
      });
      const dark = document.documentElement.dataset.theme === "dark";
      const english = window.yourcharLocale?.locale === "en";
      document.getElementById("appearanceStatus").textContent = english
        ? (appearance.preference === "system" ? "Following system · currently " : "Currently ") + (dark ? "dark" : "light") + ". This choice is saved in this browser."
        : (appearance.preference === "system" ? "跟随系统 · 当前为" : "当前为") + (dark ? "深色外观" : "浅色外观") + "，选择会保存在此浏览器。";
    }
    document.getElementById("appearanceChoices").addEventListener("click", event => {
      const button = event.target.closest("[data-theme-choice]");
      if (button) window.yourcharAppearance.apply(button.dataset.themeChoice, true);
    });
    window.addEventListener("yourchar:themechange", updateAppearanceControls);
    window.addEventListener("yourchar:localechange", updateAppearanceControls);
    updateAppearanceControls();
`;
