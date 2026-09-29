"""
SmartHomeControl Module: Direct HomeKit and smart device control.

Provides APIs for:
- Discovering smart home devices
- Controlling devices directly
- Creating and managing scenes
- Automation rules
"""

from dataclasses import dataclass, field
from typing import Optional, List, Dict
from enum import Enum
from datetime import datetime
import json
from pathlib import Path


class DeviceType(Enum):
    """Types of smart home devices."""
    LIGHT = "light"
    SWITCH = "switch"
    THERMOSTAT = "thermostat"
    LOCK = "lock"
    CAMERA = "camera"
    OUTLET = "outlet"
    FAN = "fan"
    SPEAKER = "speaker"
    BLIND = "blind"
    PLUG = "plug"


class DeviceStatus(Enum):
    """Device status."""
    ON = "on"
    OFF = "off"
    AVAILABLE = "available"
    UNAVAILABLE = "unavailable"


@dataclass
class SmartDevice:
    """A smart home device."""
    device_id: str
    name: str
    device_type: DeviceType
    status: DeviceStatus
    location: str  # Room name
    manufacturer: str = ""
    model: str = ""
    properties: dict = field(default_factory=dict)  # device-specific properties
    supported_commands: List[str] = field(default_factory=list)


@dataclass
class Scene:
    """A smart home scene (group of device states)."""
    scene_id: str
    name: str
    description: str
    devices: Dict[str, dict] = field(default_factory=dict)  # device_id -> desired_state
    icon: str = "scene"
    created_at: str = ""


@dataclass
class Automation:
    """An automation rule."""
    automation_id: str
    name: str
    trigger: str  # "time", "sensor", "scene", "manual"
    trigger_value: str
    actions: List[dict] = field(default_factory=list)  # List of {device_id, command, value}
    enabled: bool = True
    created_at: str = ""


class SmartHomeControl:
    """Smart home device management."""
    
    def __init__(self, storage_path: Optional[str] = None):
        self.storage_path = Path(storage_path or "~/Documents/Jarvis/.jarvis").expanduser()
        self.storage_path.mkdir(parents=True, exist_ok=True)
        self.devices_file = self.storage_path / "smart_devices.json"
        self.scenes_file = self.storage_path / "smart_scenes.json"
        self.automations_file = self.storage_path / "smart_automations.json"
        
        self.devices: Dict[str, SmartDevice] = {}
        self.scenes: Dict[str, Scene] = {}
        self.automations: Dict[str, Automation] = {}
        self._load_devices()
    
    def _load_devices(self) -> None:
        """Load devices from disk."""
        if self.devices_file.exists():
            try:
                with open(self.devices_file) as f:
                    data = json.load(f)
                    # Reconstruct devices (simplified)
                    devices_list = data.get("devices", []) if isinstance(data, dict) else []
                    for dev_data in devices_list:
                        if isinstance(dev_data, dict):
                            device_id = dev_data.get("device_id")
                            if device_id:
                                self.devices[device_id] = dev_data
            except (json.JSONDecodeError, TypeError, AttributeError):
                pass
    
    def _save_devices(self) -> None:
        """Persist devices to disk."""
        data = {"devices": list(self.devices.values())}
        with open(self.devices_file, 'w') as f:
            json.dump(data, f, indent=2, default=str)
    
    async def discover_devices(self) -> List[SmartDevice]:
        """
        Discover available smart home devices.
        
        In production, would query HomeKit, Matter, or directly communicate
        with devices over local network.
        
        Returns:
            List of SmartDevice objects
        """
        # Mock discovery
        devices = []
        
        # Example devices
        device_specs = [
            {
                "name": "Living Room Light",
                "device_type": DeviceType.LIGHT,
                "location": "Living Room",
                "commands": ["on", "off", "brightness"]
            },
            {
                "name": "Front Door Lock",
                "device_type": DeviceType.LOCK,
                "location": "Entryway",
                "commands": ["lock", "unlock"]
            },
            {
                "name": "Thermostat",
                "device_type": DeviceType.THERMOSTAT,
                "location": "Hallway",
                "commands": ["set_temperature", "set_mode"]
            }
        ]
        
        for spec in device_specs:
            import uuid
            device_id = str(uuid.uuid4())
            device = SmartDevice(
                device_id=device_id,
                name=spec["name"],
                device_type=spec["device_type"],
                status=DeviceStatus.AVAILABLE,
                location=spec["location"],
                manufacturer="HomeKit",
                supported_commands=spec.get("commands", [])
            )
            devices.append(device)
            self.devices[device_id] = device
        
        self._save_devices()
        return devices
    
    async def control_device(
        self,
        device_id: str,
        command: str,
        value: Optional[str] = None
    ) -> dict:
        """
        Send control command to device.
        
        Args:
            device_id: Device ID
            command: Command to send (e.g., "on", "off", "brightness")
            value: Optional command value
            
        Returns:
            Success dict with result
        """
        if device_id not in self.devices:
            return {"success": False, "error": "Device not found"}
        
        device = self.devices[device_id]
        
        if command not in device.supported_commands:
            return {"success": False, "error": f"Device doesn't support {command}"}
        
        # In production, would send actual control command
        # to device via HomeKit, Matter, local API, etc.
        
        return {
            "success": True,
            "device_id": device_id,
            "device_name": device.name,
            "command": command,
            "value": value,
            "timestamp": datetime.now().isoformat()
        }
    
    async def create_scene(
        self,
        name: str,
        description: str,
        actions: Dict[str, dict]  # device_id -> desired_state
    ) -> Scene:
        """
        Create a new smart home scene.
        
        Args:
            name: Scene name
            description: Scene description
            actions: Dict of device_id -> state changes
            
        Returns:
            Created Scene
        """
        import uuid
        scene_id = str(uuid.uuid4())
        
        scene = Scene(
            scene_id=scene_id,
            name=name,
            description=description,
            devices=actions,
            created_at=datetime.now().isoformat()
        )
        
        self.scenes[scene_id] = scene
        return scene
    
    async def activate_scene(self, scene_id: str) -> dict:
        """
        Activate a scene (apply all device states).
        
        Args:
            scene_id: Scene ID
            
        Returns:
            Execution result
        """
        if scene_id not in self.scenes:
            return {"success": False, "error": "Scene not found"}
        
        scene = self.scenes[scene_id]
        
        # Execute all device commands
        results = []
        for device_id, state in scene.devices.items():
            for command, value in state.items():
                result = await self.control_device(device_id, command, str(value))
                results.append(result)
        
        return {
            "success": True,
            "scene_id": scene_id,
            "scene_name": scene.name,
            "devices_controlled": len(scene.devices),
            "commands_sent": len(results)
        }
    
    async def create_automation(
        self,
        name: str,
        trigger: str,
        trigger_value: str,
        actions: List[dict]
    ) -> Automation:
        """
        Create an automation rule.
        
        Args:
            name: Automation name
            trigger: Trigger type ("time", "sensor", "manual")
            trigger_value: Trigger value (e.g., time like "08:00")
            actions: List of actions to execute
            
        Returns:
            Created Automation
        """
        import uuid
        automation_id = str(uuid.uuid4())
        
        automation = Automation(
            automation_id=automation_id,
            name=name,
            trigger=trigger,
            trigger_value=trigger_value,
            actions=actions,
            created_at=datetime.now().isoformat()
        )
        
        self.automations[automation_id] = automation
        return automation
    
    async def get_device_status(self, device_id: str) -> dict:
        """
        Get current status of a device.
        
        Args:
            device_id: Device ID
            
        Returns:
            Device status dict
        """
        if device_id not in self.devices:
            return {"error": "Device not found"}
        
        device = self.devices[device_id]
        return {
            "device_id": device_id,
            "name": device.get("name", "Unknown") if isinstance(device, dict) else device.name,
            "status": device.get("status", "unknown") if isinstance(device, dict) else device.status.value,
            "location": device.get("location", "") if isinstance(device, dict) else device.location
        }
    
    async def list_all_devices(self) -> dict:
        """
        List all discovered devices.
        
        Returns:
            Dict with devices organized by type and location
        """
        by_type = {}
        by_location = {}
        
        for device_id, device in self.devices.items():
            device_dict = device if isinstance(device, dict) else {
                "device_id": device.device_id,
                "name": device.name,
                "type": device.device_type.value,
                "location": device.location,
                "status": device.status.value
            }
            
            device_type = device_dict.get("type", "unknown")
            location = device_dict.get("location", "unknown")
            
            if device_type not in by_type:
                by_type[device_type] = []
            by_type[device_type].append(device_dict)
            
            if location not in by_location:
                by_location[location] = []
            by_location[location].append(device_dict)
        
        return {
            "total_devices": len(self.devices),
            "by_type": by_type,
            "by_location": by_location
        }


# MCP Server builder
def build_server():
    """Build MCP server for SmartHomeControl."""
    
    home = SmartHomeControl()
    
    class SmartHomeServer:
        """MCP server for smart home operations."""
        
        def __init__(self):
            self.home = home
        
        async def discover_devices(self) -> dict:
            """Discover smart home devices."""
            devices = await self.home.discover_devices()
            return {
                "devices_found": len(devices),
                "devices": [
                    {
                        "device_id": d.device_id,
                        "name": d.name,
                        "type": d.device_type.value,
                        "location": d.location
                    }
                    for d in devices
                ]
            }
        
        async def control_device(
            self,
            device_id: str,
            command: str,
            value: Optional[str] = None
        ) -> dict:
            """Control a device."""
            return await self.home.control_device(device_id, command, value)
        
        async def create_scene(
            self,
            name: str,
            description: str,
            actions: dict
        ) -> dict:
            """Create a scene."""
            scene = await self.home.create_scene(name, description, actions)
            return {
                "success": True,
                "scene_id": scene.scene_id,
                "name": scene.name
            }
        
        async def activate_scene(self, scene_id: str) -> dict:
            """Activate a scene."""
            return await self.home.activate_scene(scene_id)
        
        async def list_devices(self) -> dict:
            """List all devices."""
            return await self.home.list_all_devices()
    
    return SmartHomeServer()
