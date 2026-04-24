// §3.22 Link — navigate to another surface. External links open a new tab.
export function Link({ href, external = false, children, class: className = "", ...rest }) {
  if (external) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        class={`link-external ${className}`.trim()}
        {...rest}
      >
        {children}
      </a>
    );
  }
  return (
    <a href={href} class={className} {...rest}>
      {children}
    </a>
  );
}
