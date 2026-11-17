using System.Windows;
using AgentTower.Logic;

namespace AgentTower.Tests;

public class PlacementTests
{
    private static readonly Rect WorkArea = new(0, 0, 1920, 1040);

    [Fact]
    public void DefaultRect_is_bottom_right_with_margin() =>
        Assert.Equal(new Rect(1524, 524, 380, 500), Placement.DefaultRect(WorkArea, 380, 500));

    [Fact]
    public void DefaultRect_respects_a_work_area_that_does_not_start_at_zero() =>
        Assert.Equal(new Rect(100 + 1000 - 380 - 16, 50 + 800 - 500 - 16, 380, 500),
            Placement.DefaultRect(new Rect(100, 50, 1000, 800), 380, 500));

    [Fact]
    public void ClampHeight_caps_at_70_percent_and_floors_at_header()
    {
        Assert.Equal(728, Placement.ClampHeight(2000, 52, WorkArea));
        Assert.Equal(52, Placement.ClampHeight(10, 52, WorkArea));
        Assert.Equal(400, Placement.ClampHeight(400, 52, WorkArea));
    }

    [Fact]
    public void IsReachable_false_for_a_window_on_a_monitor_that_is_gone() =>
        Assert.False(Placement.IsReachable(new Rect(2500, 300, 380, 500), new[] { WorkArea }));

    [Fact]
    public void IsReachable_true_when_100_by_40_is_visible() =>
        Assert.True(Placement.IsReachable(new Rect(1820, 1000, 380, 500), new[] { WorkArea }));

    [Fact]
    public void IsReachable_false_when_only_a_sliver_is_visible() =>
        Assert.False(Placement.IsReachable(new Rect(1821, 1000, 380, 500), new[] { WorkArea }));

    [Fact]
    public void ClampLeft_pulls_back_a_window_that_hangs_over_the_right_edge() =>
        Assert.Equal(1520, Placement.ClampLeft(1542, 400, WorkArea));

    [Fact]
    public void ClampLeft_pulls_back_a_window_that_hangs_over_the_left_edge() =>
        Assert.Equal(0, Placement.ClampLeft(-30, 400, WorkArea));

    [Fact]
    public void ClampLeft_leaves_a_window_inside_alone() =>
        Assert.Equal(700, Placement.ClampLeft(700, 400, WorkArea));

    [Fact]
    public void ClampLeft_works_on_a_second_monitor() =>
        Assert.Equal(3440, Placement.ClampLeft(3500, 400, new Rect(1920, 0, 1920, 1040)));

    // ---------- Snap: the window is 400 x 500, the snapping distance 12 ----------

    private static Rect At(double left, double top) => new(left, top, 400, 500);

    [Theory]
    [InlineData(1515, 300, 1520, 300)] // right edge 5 before the screen edge
    [InlineData(1528, 300, 1520, 300)] // hangs 8 over the right edge
    [InlineData(9, 300, 0, 300)] // left edge
    [InlineData(700, 7, 700, 0)] // top edge
    [InlineData(700, 531, 700, 540)] // bottom edge of the work area (the taskbar)
    [InlineData(1512, 533, 1520, 540)] // a corner: both axes
    [InlineData(1400, 300, 1400, 300)] // far from every edge: untouched
    [InlineData(1507, 300, 1507, 300)] // 13 away: just outside the distance
    public void Snap_pulls_a_side_onto_a_work_area_edge_within_the_distance(double left, double top, double wantLeft, double wantTop) =>
        Assert.Equal(At(wantLeft, wantTop), Placement.Snap(At(left, top), new[] { WorkArea }, 12));

    [Fact]
    public void Snap_knows_the_edges_of_every_monitor()
    {
        var areas = new[] { WorkArea, new Rect(1920, 0, 2560, 1400) };
        Assert.Equal(At(1920, 300), Placement.Snap(At(1925, 300), areas, 12)); // left edge of the second monitor
        Assert.Equal(At(1520, 300), Placement.Snap(At(1512, 300), areas, 12)); // right edge of the first
        Assert.Equal(At(4080, 900), Placement.Snap(At(4075, 893), areas, 12)); // bottom right corner of the second
    }

    [Fact]
    public void Snap_ignores_an_edge_of_a_monitor_the_window_is_not_next_to()
    {
        // The second monitor hangs below the first and starts at x = 500. Its left edge must not
        // attract a window that is up on the first monitor.
        var areas = new[] { WorkArea, new Rect(500, 1040, 1920, 1040) };
        Assert.Equal(At(505, 300), Placement.Snap(At(505, 300), areas, 12));
    }

    [Fact]
    public void Snap_takes_the_nearer_of_two_edges()
    {
        // Two areas chosen so that both sides have an edge in reach: the left side is 3 away
        // from its edge (1000), the right side 2 away from its edge (1405). The nearer one wins.
        var areas = new[] { new Rect(1000, 0, 2000, 1040), new Rect(0, 0, 1405, 1040) };
        Assert.Equal(At(1005, 300), Placement.Snap(At(1003, 300), areas, 12));
    }

    // ---------- Docked: which sides lie on a work-area edge ----------

    [Theory]
    [InlineData(700, 300, Sides.None)]
    [InlineData(1520, 300, Sides.Right)]
    [InlineData(0, 300, Sides.Left)]
    [InlineData(700, 0, Sides.Top)]
    [InlineData(700, 540, Sides.Bottom)]
    [InlineData(1520, 0, Sides.Top | Sides.Right)]
    [InlineData(0, 540, Sides.Left | Sides.Bottom)]
    [InlineData(1519.6, 300, Sides.Right)] // rounding of device pixels
    [InlineData(1518, 300, Sides.None)] // near is not docked
    public void Docked_names_the_sides_on_an_edge(double left, double top, Sides want) =>
        Assert.Equal(want, Placement.Docked(At(left, top), new[] { WorkArea }));

    [Fact]
    public void Docked_knows_every_monitor_but_only_one_the_window_is_beside()
    {
        Assert.Equal(Sides.Left, Placement.Docked(At(1920, 300), new[] { WorkArea, new Rect(1920, 0, 2560, 1400) }));
        // x = 500 is the left edge of a monitor that hangs below: not docked up here.
        Assert.Equal(Sides.None, Placement.Docked(At(500, 300), new[] { WorkArea, new Rect(500, 1040, 1920, 1040) }));
    }

    [Fact]
    public void IsReachable_true_on_a_second_monitor() =>
        Assert.True(Placement.IsReachable(new Rect(2500, 300, 380, 500), new[] { WorkArea, new Rect(1920, 0, 1920, 1040) }));
}
