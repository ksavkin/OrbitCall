"""SpaceObject.kind and maneuverability (team spec §2.2, ROOM-14) from what the pinned snapshot actually contains.

Rule (first match wins), every result carries its basis:
1. simulated object (POST /simulate)            → payload, maneuverable: the demo satellite is defined as one that
                                                  can burn (labeled simulated, never real evidence);
2. name token "DEB"/"DEBRIS"                     → debris, non_maneuverable;
3. name token "R/B" (wins over any group: "RS-44 & BREEZE-KM R/B" is a payload still attached to its upper stage)
                                                → rocket_body, non_maneuverable;
3b. a "*-debris" group                          → debris, non_maneuverable;
4. CelesTrak payload groups (active, stations,   → payload; maneuverability from the SOCRATES SATCAT status:
   gnss)                                           "-" (nonoperational) or "D" (decayed) → non_maneuverable,
                                                  anything else → unknown (operational does not prove propulsion);
5. otherwise                                     → unknown; SATCAT "-"/"D" → non_maneuverable, else unknown.
Maneuverable is never inferred for a real object: the public data has no propulsion field.
"""

from .catalog import Catalog, Obj

PAYLOAD_GROUPS = {"active", "stations", "gnss"}
RULE = ("simulated → payload/maneuverable (demo); ' DEB' or a debris group → debris/non_maneuverable; ' R/B' → "
        "rocket_body/non_maneuverable; active/stations/gnss → payload with SOCRATES status '-'/'D' → "
        "non_maneuverable else unknown; otherwise unknown/unknown. Public data has no propulsion field, so a real "
        "object is never classified maneuverable.")


def classify(cat: Catalog, obj: Obj) -> dict:
    name = f" {obj.name.upper()} "
    status = cat.status.get(obj.object_id)
    if obj.simulated:
        kind, man, basis = "payload", "maneuverable", "simulated demo satellite"
    elif " DEB " in name or " DEBRIS " in name:  # space-padded name: a token, not "DEBUT"
        kind, man, basis = "debris", "non_maneuverable", "name (DEB)"
    elif " R/B " in name:  # the name marker wins over any group
        kind, man, basis = "rocket_body", "non_maneuverable", "name (R/B)"
    elif obj.group.endswith("-debris"):
        kind, man, basis = "debris", "non_maneuverable", f"group ({obj.group})"
    elif obj.group in PAYLOAD_GROUPS:
        kind = "payload"
        man = "non_maneuverable" if status in ("-", "D") else "unknown"
        basis = f"CelesTrak group {obj.group}" + (f", SOCRATES status [{status}]" if status else ", no SOCRATES status")
    else:
        kind = "unknown"
        man = "non_maneuverable" if status in ("-", "D") else "unknown"
        basis = f"group {obj.group or 'none'}" + (f", SOCRATES status [{status}]" if status else "")
    return {"objectId": obj.object_id, "name": obj.name, "kind": kind, "maneuverability": man,
            "classificationBasis": basis, "operationalStatus": status, "group": obj.group, "simulated": obj.simulated}


def movable(cat: Catalog, obj: Obj) -> bool:
    """Debris, rocket bodies and nonoperational payloads cannot be the moving object (ROOM-14)."""
    return classify(cat, obj)["maneuverability"] != "non_maneuverable"
