from setuptools import find_packages, setup

package_name = "carrier_action_server"

setup(
    name=package_name,
    version="0.1.0",
    packages=find_packages(exclude=["test"]),
    data_files=[
        ("share/ament_index/resource_index/packages", [f"resource/{package_name}"]),
        (f"share/{package_name}", ["package.xml"]),
    ],
    install_requires=["setuptools"],
    zip_safe=True,
    maintainer="vicpinky",
    maintainer_email="pjsu94@gmail.com",
    description="Action server node for the carrier robot system",
    license="Apache-2.0",
    entry_points={
        "console_scripts": [
            "action_server = carrier_action_server.action_server:main",
        ],
    },
)
