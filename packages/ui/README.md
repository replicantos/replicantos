# `@replicantos/ui`

Shared, code-native presentation contracts for ReplicantOS applications.

## Exports

| Export                       | Purpose                                                                |
| ---------------------------- | ---------------------------------------------------------------------- |
| `@replicantos/ui`            | Typed design token entrypoint                                          |
| `@replicantos/ui/tokens`     | Direct typed token map for canvas, charts, and other non-CSS rendering |
| `@replicantos/ui/tokens.css` | Canonical CSS custom properties for product and public-site styles     |

CSS consumers should import the stable token layer before application styles:

```css
@import "@replicantos/ui/tokens.css";
```

The static landing build copies the same canonical file into its output, so the
public site and application do not maintain competing palettes. The package has
no font, image, network, telemetry, or runtime dependency.
