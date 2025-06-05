import math

EARTH_RADIUS_METERS = 6371000

def haversine_distance_meters(
    lat1: float,
    lon1: float,
    lat2: float,
    lon2: float,
) -> float:
    """
    Compute the great-circle distance between two points on the Earth's surface
    using the Haversine formula.

    Parameters:
        lat1, lon1: Latitude and Longitude of point 1 (in decimal degrees)
        lat2, lon2: Latitude and Longitude of point 2 (in decimal degrees)

    Returns:
        Distance in kilometers between the two points.
    """
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_lambda = math.radians(lon2 - lon1)
    delta_phi = phi2 - phi1

    # Haversine formula
    a = math.sin(0.5 * delta_phi)**2 + \
        math.cos(phi1) * math.cos(phi2) * math.sin(0.5 * delta_lambda)**2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

    distance = EARTH_RADIUS_METERS * c
    return distance


def arrow_angle(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """
    Compute the angle of an arrow (in radians) between two lat/lon points
    projected into 2D space.

    Parameters:
        lat1, lon1: Start point (latitude and longitude in decimal degrees)
        lat2, lon2: End point (latitude and longitude in decimal degrees)

    Returns:
        Angle in radians, with north as 0 and east as pi/2.
    """
    # No need to convert everything to radians, because the conversion does not
    # affect the ratio.
    dx = (lon2 - lon1) * math.cos(math.radians(lat1))
    dy = lat2 - lat1
    return math.atan2(dx, dy)
