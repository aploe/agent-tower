using System.Windows;

namespace AgentTower.Logic;

/// <summary>Sides of the window, for "which of them lie on a screen edge".</summary>
[Flags]
public enum Sides
{
    None = 0,
    Left = 1,
    Top = 2,
    Right = 4,
    Bottom = 8,
}

/// <summary>Where the window goes and how tall it may be. Pure: all screens come in as rectangles.</summary>
public static class Placement
{
    /// <summary>Bottom right of the work area, <paramref name="margin"/> away from both edges.</summary>
    public static Rect DefaultRect(Rect workArea, double width, double height, double margin = 16) =>
        new(workArea.Right - width - margin, workArea.Bottom - height - margin, width, height);

    /// <summary>The page's wish, kept between the header height and 70 % of the work area.</summary>
    public static double ClampHeight(double requested, double headerHeight, Rect workArea) =>
        Math.Max(headerHeight, Math.Min(requested, 0.7 * workArea.Height));

    /// <summary>
    /// The left edge moved just far enough that the whole width lies on the work area. A window
    /// dragged a little past the screen edge comes back at the next start.
    /// </summary>
    public static double ClampLeft(double left, double width, Rect workArea) =>
        Math.Max(workArea.Left, Math.Min(left, workArea.Right - width));

    /// <summary>
    /// While the window is dragged: each side that comes within <paramref name="distance"/> of the
    /// same side of a work area jumps onto it (left to left, right to right, top to top, bottom
    /// to bottom, so the bottom lands on the taskbar). Every monitor's work area counts, but only
    /// one the window is beside: a far monitor's edge does not pull. Per axis the nearest edge wins.
    /// </summary>
    public static Rect Snap(Rect window, IEnumerable<Rect> workAreas, double distance)
    {
        double? dx = null, dy = null;
        foreach (var area in workAreas)
        {
            var besideVertically = window.Top < area.Bottom + distance && window.Bottom > area.Top - distance;
            var besideHorizontally = window.Left < area.Right + distance && window.Right > area.Left - distance;
            if (besideVertically)
            {
                dx = Nearer(dx, area.Left - window.Left, distance);
                dx = Nearer(dx, area.Right - window.Right, distance);
            }
            if (besideHorizontally)
            {
                dy = Nearer(dy, area.Top - window.Top, distance);
                dy = Nearer(dy, area.Bottom - window.Bottom, distance);
            }
        }
        return new Rect(window.Left + (dx ?? 0), window.Top + (dy ?? 0), window.Width, window.Height);
    }

    /// <summary>
    /// The sides that lie on the same side of a work area the window is beside (within
    /// <paramref name="tolerance"/>, for the rounding of device pixels). These are the sides
    /// the window is snapped to.
    /// </summary>
    public static Sides Docked(Rect window, IEnumerable<Rect> workAreas, double tolerance = 0.5)
    {
        var sides = Sides.None;
        foreach (var area in workAreas)
        {
            var besideVertically = window.Top < area.Bottom + tolerance && window.Bottom > area.Top - tolerance;
            var besideHorizontally = window.Left < area.Right + tolerance && window.Right > area.Left - tolerance;
            if (besideVertically)
            {
                if (Math.Abs(area.Left - window.Left) <= tolerance) sides |= Sides.Left;
                if (Math.Abs(area.Right - window.Right) <= tolerance) sides |= Sides.Right;
            }
            if (besideHorizontally)
            {
                if (Math.Abs(area.Top - window.Top) <= tolerance) sides |= Sides.Top;
                if (Math.Abs(area.Bottom - window.Bottom) <= tolerance) sides |= Sides.Bottom;
            }
        }
        return sides;
    }

    private static double? Nearer(double? best, double shift, double distance) =>
        Math.Abs(shift) <= distance && (best is null || Math.Abs(shift) < Math.Abs(best.Value)) ? shift : best;

    /// <summary>
    /// True when enough of the window lies on some work area to grab it: at least 100 wide and
    /// 40 high. A stored position on a monitor that is gone fails this.
    /// </summary>
    public static bool IsReachable(Rect window, IEnumerable<Rect> workAreas)
    {
        foreach (var area in workAreas)
        {
            var visible = Rect.Intersect(window, area);
            if (!visible.IsEmpty && visible.Width >= 100 && visible.Height >= 40) return true;
        }
        return false;
    }
}
