document.documentElement.dataset.runtime = "static";

const mobileNavigation = document.querySelector("[data-mobile-navigation]");

if (mobileNavigation instanceof HTMLDetailsElement) {
  for (const link of mobileNavigation.querySelectorAll("a")) {
    link.addEventListener("click", () => {
      mobileNavigation.open = false;
    });
  }
}

for (const anchor of document.querySelectorAll('a[href^="#"]')) {
  anchor.addEventListener("click", () => {
    const targetId = anchor.getAttribute("href")?.slice(1);
    const target = targetId ? document.getElementById(targetId) : null;

    if (target && !target.hasAttribute("tabindex")) {
      target.setAttribute("tabindex", "-1");
      target.addEventListener(
        "blur",
        () => {
          target.removeAttribute("tabindex");
        },
        { once: true },
      );
    }
  });
}
